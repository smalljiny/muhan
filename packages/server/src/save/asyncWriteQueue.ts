/**
 * 비동기 write-behind 큐 — 게임 틱과 영속화 write를 분리한다.
 *
 * 게임 루프(1Hz)가 DirtyTracker에서 뽑은 DirtyEntry를 enqueue하면, 이 큐가 백그라운드
 * 워커로 collection별 어댑터를 통해 Mongo에 drain한다. 틱 스레드는 write I/O 지연에
 * 블로킹되지 않는다.
 *
 * 설계 결정:
 *
 * 1. dispatch 주입 — collection별 write 어댑터를 생성자로 주입받는다(전역 싱글턴·서비스
 *    로케이터 금지). 테스트는 mock 어댑터를, 프로덕션은 repo 메서드를 감싼 어댑터를 넣는다.
 *    roomStates는 id가 roomId이지만 upsert가 snapshot 자체로 키를 결정하므로 어댑터가 흡수한다.
 *
 * 2. coalescing (last-value-wins) — pending을 `Map<"collection:id", DirtyEntry>`로 관리해
 *    같은 키 재-enqueue 시 최신값으로 덮어쓴다. Map의 삽입 순서 보존으로 FIFO도 만족한다.
 *    **호출 계약**: coalescing이 "최종 write 1회"로 성립하려면 같은 키를 yield 없이 동기
 *    burst로 enqueue해야 한다(워커 시작을 microtask로 지연해 burst가 pending에 먼저 쌓이게
 *    한다). SaveScheduler는 이미 coalesce된 DirtyTracker를 drain해 동기 enqueue하므로 성립한다.
 *
 * 3. capacity-full backpressure (pending-only) — capacity는 pending Map 크기만 제한한다.
 *    coalescing 후에도 pending이 capacity 이상이면 enqueue가 공간이 생길 때까지 await(block)해
 *    무한 성장을 막는다. 워커가 항목을 in-flight로 **가져갈 때**(take) 슬롯 1개를 비우고
 *    대기 중인 enqueue 하나를 깨운다. 대기자는 while로 재확인하므로 spurious wake에 안전하다.
 *
 * 4. 재시도 분류 — DocumentNotFoundError(matched=0)와 ZodError(스키마 검증 실패)는 permanent로
 *    분류해 재시도 없이 logger로 기록하고 폐기한다(stale id·malformed snapshot은 재시도해도
 *    성공 못 함 — snapshot 구성 버그). 그 외 에러(네트워크·일시 write 실패)는 transient로
 *    분류해 MAX_RETRIES회 backoff 재시도 후 성공하거나 최종 실패로 폐기·기록한다.
 *    writeWithRetry는 어떤 경로에서도 throw하지 않아(catch-return) 한 job의 실패가 워커 루프를
 *    죽이지 않는다. 나아가 work()가 per-job try/catch로 감싸 주입된 logger·sleep이 throw해도
 *    워커가 reject하지 않는다(장수 서버의 unhandled rejection 방지).
 *
 * 5. backoff seam — sleep 함수를 주입 가능하게 두어(기본값 실제 setTimeout) 테스트에서 즉시
 *    resolve로 대체한다. 비결정적 타이밍 테스트를 피한다. 워커는 지속 타이머를 쓰지 않으므로
 *    (setTimeout은 backoff 동안만 존재하고 resolve됨) 프로세스를 살려두지 않는다 — unref 불필요.
 *
 * 소비자 계약 (SaveScheduler·SaveEngine):
 *
 * 1. coalescing은 **동기 burst**에서만 성립한다. `for..await enqueue`처럼 각 enqueue를 awaiting
 *    하면 워커가 그 사이 항목을 가져가 per-write로 degrade한다(최종값은 정확하지만 dedup 없음).
 *    SaveScheduler는 이미 coalesce된 DirtyTracker 스냅샷을 yield 없이 동기 enqueue해야 한다.
 * 2. `enqueue`는 pending이 capacity를 초과하면 backpressure로 block한다(즉시 반환 아님).
 *    틱 소유자는 enqueue가 await할 수 있음을 예상하고 호출해야 한다.
 * 3. snapshot은 **참조로 저장**된다(복사·동결하지 않는다). DirtyTracker가 fresh·immutable
 *    스냅샷을 공급해야 한다(dirtyTracker.ts의 "라이브 참조 금지" 계약과 정합).
 * 4. 실제 logger 주입은 **필수**다(생성자 파라미터, 미주입 시 컴파일 에러). 미주입 시 permanent·
 *    재시도소진 실패가 무흔적으로 폐기되므로 타입 단계에서 계약을 강제한다.
 */

import { ZodError } from 'zod'
import type { DirtyEntry } from './dirtyTracker.js'
import type { SaveLogger } from './logger.js'
import { DocumentNotFoundError } from '../repo/types.js'

/** 기본 pending 상한. capacity를 초과하면 enqueue가 backpressure로 block한다. */
export const DEFAULT_CAPACITY = 1024

/** transient 에러의 최대 재시도 횟수. 총 시도 = 1(초기) + MAX_RETRIES. */
export const MAX_RETRIES = 3

/** backoff 기본 base delay(ms). 실제 지연은 base × 2^(attempt-1). */
const DEFAULT_BASE_DELAY_MS = 50

/** collection별 write 어댑터 — (id, snapshot)을 받아 영속화한다. */
export type WriteAdapter = (id: string, snapshot: unknown) => Promise<void>

/** collection 이름 → write 어댑터 맵. */
export type DispatchMap = Record<string, WriteAdapter>

/** AsyncWriteQueue 생성 옵션. */
export interface AsyncWriteQueueOptions {
  /** pending 상한(기본 DEFAULT_CAPACITY). */
  readonly capacity?: number
  /** transient 최대 재시도(기본 MAX_RETRIES). */
  readonly maxRetries?: number
  /** backoff sleep seam(기본 실제 setTimeout). */
  readonly sleep?: (ms: number) => Promise<void>
  /** backoff base delay ms(기본 DEFAULT_BASE_DELAY_MS). */
  readonly baseDelayMs?: number
}

/** 기본 backoff sleep — 실제 setTimeout. */
const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

export class AsyncWriteQueue {
  private readonly dispatch: DispatchMap
  public readonly capacity: number
  private readonly maxRetries: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly baseDelayMs: number
  private readonly logger: SaveLogger

  /** pending job — 키(collection:id)당 최신 스냅샷 1건(coalescing + FIFO). */
  private readonly pending = new Map<string, DirtyEntry>()
  /** capacity로 block된 enqueue의 resolver 큐(슬롯이 비면 하나씩 깨운다). */
  private readonly waiters: Array<() => void> = []
  /** 현재 어댑터가 write 중인 in-flight job 수(drain 완료 판정용). */
  private inFlight = 0
  /** 활성 워커 루프 promise(없으면 null). */
  private workerPromise: Promise<void> | null = null
  /** 워커 시작이 microtask로 예약됐는지 여부(중복 예약 방지). */
  private pumpScheduled = false

  constructor(
    dispatch: DispatchMap,
    logger: SaveLogger,
    options: AsyncWriteQueueOptions = {},
  ) {
    this.dispatch = dispatch
    this.logger = logger
    this.capacity = options.capacity ?? DEFAULT_CAPACITY
    this.maxRetries = options.maxRetries ?? MAX_RETRIES
    this.sleep = options.sleep ?? realSleep
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS
  }

  /** 현재 pending job 개수(테스트·검사용). */
  get pendingSize(): number {
    return this.pending.size
  }

  /**
   * job을 큐에 넣는다. pending에 여유가 있으면 즉시 반환하고(틱 비블로킹) 워커가 백그라운드로
   * drain한다. 같은 키가 이미 pending이면 최신값으로 coalescing한다(성장 없음, 즉시 수락).
   * pending이 capacity 이상이고 새 키면 공간이 생길 때까지 await한다(backpressure).
   */
  async enqueue(job: DirtyEntry): Promise<void> {
    const key = `${job.collection}:${job.id}`
    // coalescing으로 흡수되지 않는(새 키) 경우에만 capacity를 강제한다.
    // 여유 있는 공통 경로에서 Map.has() 조회를 건너뛰도록 저렴한 size 비교를 먼저 둔다.
    while (this.pending.size >= this.capacity && !this.pending.has(key)) {
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve)
      })
    }
    this.pending.set(key, job)
    this.schedulePump()
  }

  /**
   * 현재 pending·in-flight write가 모두 완료될 때까지 await한다. 반환 후 큐가 빈다.
   * SaveEngine.shutdown이 소비한다. enqueue가 멈춘 상태(셧다운)를 전제한다.
   */
  async drain(): Promise<void> {
    while (this.pending.size > 0 || this.workerPromise !== null || this.inFlight > 0) {
      this.ensureWorker()
      if (this.workerPromise !== null) {
        await this.workerPromise
      } else {
        await Promise.resolve()
      }
    }
  }

  /**
   * 워커 시작을 microtask로 지연 예약한다. 동기 burst enqueue가 모두 pending에 쌓인 뒤
   * 워커가 첫 항목을 가져가도록 해 coalescing을 "최종 write 1회"로 성립시킨다.
   */
  private schedulePump(): void {
    if (this.workerPromise !== null || this.pumpScheduled) return
    this.pumpScheduled = true
    queueMicrotask(() => {
      this.pumpScheduled = false
      this.ensureWorker()
    })
  }

  /** pending이 있고 워커가 놀고 있으면 워커 루프를 시작한다. */
  private ensureWorker(): void {
    if (this.workerPromise !== null) return
    if (this.pending.size === 0) return
    this.workerPromise = this.work().finally(() => {
      this.workerPromise = null
    })
  }

  /**
   * pending이 빌 때까지 순차로 항목을 가져가 write한다. writeWithRetry는 원칙적으로 throw하지
   * 않지만, 주입된 logger·sleep이 throw하면 여기서 최후 방어한다. per-job try/catch로 삼켜
   * 워커 루프가 reject하지 않게 해 백그라운드 경로의 unhandled rejection을 막는다(장수 서버 안전).
   */
  private async work(): Promise<void> {
    // 바깥 방어 — 루프 스캐폴딩(entries·delete·releaseWaiter 등)의 예기치 못한 throw까지 삼켜
    // work()가 어떤 경우에도 reject하지 않게 한다. logger 자체가 throw할 수 있으므로 최종 catch는
    // 재기록 없이 조용히 무시한다.
    try {
      while (this.pending.size > 0) {
        const next = this.pending.entries().next()
        if (next.done === true) break
        const [key, entry] = next.value
        this.pending.delete(key)
        // take 시점에 슬롯 1개를 비우고 대기 중인 enqueue 하나를 깨운다(pending-only backpressure).
        this.releaseWaiter()
        this.inFlight += 1
        try {
          await this.writeWithRetry(entry)
        } catch {
          // 안쪽 방어(load-bearing) — writeWithRetry 내부의 logger·sleep이 throw해도 삼켜 루프가
          // 다음 job으로 진행하게 한다. 바깥 catch만 두면 여기서 루프를 이탈해 후속 job이 유실된다.
        } finally {
          this.inFlight -= 1
        }
      }
    } catch {
      // 최후 방어 — 도달 불가에 가깝지만 워커가 절대 reject하지 않음을 타입·런타임 양면에서 보장.
    }
  }

  /** capacity로 대기 중인 enqueue 하나를 깨운다(FIFO). */
  private releaseWaiter(): void {
    const resolve = this.waiters.shift()
    if (resolve !== undefined) resolve()
  }

  /**
   * 어댑터로 write하되 에러를 분류해 재시도한다. 어떤 경로에서도 throw하지 않는다
   * (permanent·소진·미지 collection 모두 logger 기록 후 return) — 워커 루프 생존 보장.
   */
  private async writeWithRetry(entry: DirtyEntry): Promise<void> {
    const adapter = this.dispatch[entry.collection]
    if (adapter === undefined) {
      this.logger.error(
        { collection: entry.collection, id: entry.id },
        'write 어댑터를 찾을 수 없어 job을 폐기한다',
      )
      return
    }
    let attempt = 0
    for (;;) {
      try {
        await adapter(entry.id, entry.snapshot)
        return
      } catch (error) {
        if (error instanceof DocumentNotFoundError || error instanceof ZodError) {
          // permanent — stale/삭제된 id(DocumentNotFoundError) 또는 스키마 검증 실패(ZodError,
          // snapshot 구성 버그). 재시도해도 성공하지 못하므로 fail-fast로 기록만 한다.
          this.logger.error(
            { collection: entry.collection, id: entry.id, err: error },
            'permanent write 실패 — 재시도하지 않는다',
          )
          return
        }
        attempt += 1
        if (attempt > this.maxRetries) {
          this.logger.error(
            { collection: entry.collection, id: entry.id, err: error, attempts: attempt },
            'transient write 재시도 소진 — job을 폐기한다',
          )
          return
        }
        await this.sleep(this.backoffMs(attempt))
      }
    }
  }

  /** attempt별 지수 backoff 지연(ms). */
  private backoffMs(attempt: number): number {
    return this.baseDelayMs * 2 ** (attempt - 1)
  }
}
