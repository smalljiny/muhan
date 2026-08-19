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
 *    한다). SaveScheduler는 이미 coalesce된 DirtyTracker를 checkout해 동기 enqueue하므로 성립한다.
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
 * 6. 완료 프로토콜 (onSettled) — 워커가 dispatch한 job의 종결을 소비자에게 통지한다. "write가
 *    언제 끝났는가"는 큐만 알기 때문에, 이 통지 없이는 소비자의 스냅샷 수명 계약이 성립하지
 *    않는다. 통지 대상·시점·예외 처리 계약은 `AsyncWriteQueueOptions.onSettled` 선언부가 정본이다.
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
import { dirtyKey, type DirtyEntry } from './dirtyTracker.js'
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

/**
 * job 종결 결과 — `acked`는 어댑터 write 성공, `discarded`는 스냅샷 폐기다.
 *
 * 폐기는 permanent 실패(DocumentNotFoundError·ZodError)·재시도 소진·어댑터 미발견을 모두 포함하며,
 * 결과를 확정하지 못한 경로(주입 logger·sleep이 throw)도 보수적으로 여기 속한다 — write 성공을
 * 확인하지 못했는데 `acked`로 통지하면 아직 영속되지 않은 스냅샷이 소유자에게서 사라진다.
 */
export type WriteOutcome = 'acked' | 'discarded'

/** job 종결 통지 seam — 계약은 `AsyncWriteQueueOptions.onSettled` 선언부 참조. */
export type OnWriteSettled = (entry: DirtyEntry, outcome: WriteOutcome) => void

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
  /**
   * job 종결 통지(기본 없음). **워커가 dispatch한** job은 성공·폐기 어느 경로로 끝나도 정확히
   * 1회 통지된다.
   *
   * dispatch에 도달하지 못하고 사라지는 두 경로는 통지가 **없다**(설계상 의도) —
   *   (a) `evict`가 pending에서 취소한 job. saveNow가 `tracker.evict`를 먼저 부르므로 소비자
   *       상태는 이미 정리돼 있다.
   *   (b) 같은 키 재-enqueue로 coalescing에 밀려난 이전 스냅샷. 다음 checkout이 inProgress의
   *       그 키를 새 엔트리로 덮으므로, 밀려난 엔트리의 미통지는 참조 동일성 규칙상 무해하다.
   * 따라서 이 통지는 "enqueue한 엔트리마다 1회"가 아니다 — 통지 수를 세어 미완료 job을 추적하는
   * refcount 용도로 쓰면 두 경로에서 어긋난다.
   *
   * SaveEngine이 이 seam으로 DirtyTracker의 반납(ack/discard)을 배선한다. 인자 entry는 enqueue된
   * 것과 같은 참조다 — tracker의 반납 조건이 참조 동일성이므로 복제본을 넘기면 조용한 no-op이 된다.
   * 콜백이 throw해도 워커 루프는 생존한다(work() 주석 참조).
   */
  readonly onSettled?: OnWriteSettled
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
  private readonly onSettled?: OnWriteSettled

  /** pending job — 키(collection:id)당 최신 스냅샷 1건(coalescing + FIFO). */
  private readonly pending = new Map<string, DirtyEntry>()
  /** capacity로 block된 enqueue의 resolver 큐(슬롯이 비면 하나씩 깨운다). */
  private readonly waiters: Array<() => void> = []
  /** 현재 어댑터가 write 중인 in-flight job 수(drain 완료 판정용). */
  private inFlight = 0
  /** 현재 in-flight write의 키(collection:id) — 없으면 null. evict가 이 write 완료를 await한다. */
  private inFlightKey: string | null = null
  /** 현재 in-flight write의 완료 신호 — 없으면 null. work()가 write 시작 시 생성, 종료 시 resolve·null한다. */
  private inFlightSettled: Promise<void> | null = null
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
    this.onSettled = options.onSettled
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
    const key = dirtyKey(job.collection, job.id)
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
   * 지정 키를 큐 write 경로에서 제거한다 — pending에 있으면 취소하고, 이미 in-flight면 그 write가
   * 끝날 때까지 await한다. SaveEngine.saveNow가 즉시 write 직전에 호출해, 같은 키의 stale 큐 write가
   * saveNow의 최신 write보다 나중에 커밋돼 덮어쓰는 것을 pending·in-flight 양쪽에서 봉쇄한다.
   *
   * 반환 후 **큐가 보유한** 이 키의 미완료 write는 남지 않는다 — coalescing으로 키당 pending 1건,
   * 단일 워커로 in-flight 1건뿐이므로 pending 삭제 + in-flight await로 둘 다 소진된다.
   *
   * ⚠ 큐가 볼 수 없는 세 번째 상태가 있다. `SaveScheduler.flush()`는 `checkout()` 후 `enqueue`에서
   * capacity backpressure로 블록될 수 있고, 그 창의 엔트리는 tracker의 inProgress에는 있지만 큐의
   * pending에는 아직 없다. 이 evict는 그 엔트리를 취소하지 못하며, 반환 후 블록이 풀리면 stale
   * 엔트리가 뒤늦게 enqueue돼 saveNow의 최신 write를 덮을 수 있다. saveNow에 프로덕션 호출자가
   * 붙을 때(현재 0건) 구조적으로 닫아야 한다 — 스케줄러가 checkout 완료·enqueue 미수락 집합을
   * 노출하거나, flush를 evict-aware로 만드는 형태다.
   *
   * saveNow는 이 호출 전에 tracker.evict로 stale mark를 제거하므로, await 도중 도착한 더 새로운
   * markDirty는 evict 이후라 tracker에 남아 다음 flush로 영속화된다. 다만 saveNow **이전에 이미
   * checkout된** 엔트리는 tracker.evict가 지워도 스케줄러의 지역 배열에 살아 있어 그대로 enqueue된다.
   */
  async evict(collection: string, id: string): Promise<void> {
    const key = dirtyKey(collection, id)
    // pending에서 실제로 제거했으면 슬롯 1개가 비므로 capacity로 block된 enqueue 하나를 깨운다.
    // 이를 빠뜨리면 워커가 이 키를 take하며 슬롯을 비우는 유일한 경로가 사라져(evict가 대신 제거),
    // capacity 대기자가 영구히 방치돼 flush/shutdown이 hang한다(deadlock).
    if (this.pending.delete(key)) {
      this.releaseWaiter()
    }
    if (this.inFlightKey === key && this.inFlightSettled !== null) {
      await this.inFlightSettled
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
        // in-flight 창을 노출한다 — evict(collection,id)가 이 키의 write 완료를 await할 수 있게 한다.
        this.inFlightKey = key
        let settleInFlight!: () => void
        this.inFlightSettled = new Promise<void>((resolve) => {
          settleInFlight = resolve
        })
        // 기본값을 discarded로 두어, 결과를 확정하지 못한 경로(아래 catch)가 write 성공으로
        // 오인되지 않게 한다.
        let outcome: WriteOutcome = 'discarded'
        try {
          outcome = await this.writeWithRetry(entry)
        } catch {
          // 안쪽 방어(load-bearing) — writeWithRetry 내부의 logger·sleep이 throw해도 삼켜 루프가
          // 다음 job으로 진행하게 한다. 바깥 catch만 두면 여기서 루프를 이탈해 후속 job이 유실된다.
        } finally {
          this.notifySettled(entry, outcome)
          this.inFlight -= 1
          this.inFlightKey = null
          this.inFlightSettled = null
          settleInFlight()
        }
      }
    } catch {
      // 최후 방어 — 도달 불가에 가깝지만 워커가 절대 reject하지 않음을 타입·런타임 양면에서 보장.
    }
  }

  /**
   * job 종결을 소비자에게 통지한다. 이 메서드는 throw하지 않는다.
   *
   * 호출 위치는 in-flight 창을 닫는 것과 **같은 동기 블록**에서 settleInFlight() 앞이다 — evict가
   * in-flight write 완료를 await한 뒤에는 소비자 상태가 이미 반영돼 있어야 saveNow의
   * evict-before-write 논증이 유지된다. 다만 settleInFlight()가 큐잉하는 evict 재개보다 관측자가
   * 거치는 마이크로태스크 hop이 더 길어, 통지를 뒤로 옮겨도 밖에서는 구별되지 않는다. 즉 테스트가
   * 보증하는 강도는 "같은 동기 블록"까지이고, 그 안에서의 배치는 이 주석이 유일한 근거다.
   *
   * 통지 처리기의 throw는 삼켜 워커 루프를 보호하되(후속 job의 write까지 막지 않는다) 로그는
   * 남긴다 — 이 파일의 소비자 계약이 무흔적 폐기를 금지한다. 통지가 실패한 엔트리는 소비자 쪽에
   * 반납되지 않은 채 남고, 같은 키가 다시 dirty로 기록되지 않으면 회수되지 않는다.
   */
  private notifySettled(entry: DirtyEntry, outcome: WriteOutcome): void {
    try {
      this.onSettled?.(entry, outcome)
    } catch (error) {
      try {
        this.logger.error(
          { collection: entry.collection, id: entry.id, outcome, err: error },
          '완료 통지 처리기가 실패했다 — 소비자 반납이 누락될 수 있다',
        )
      } catch {
        // logger 자체가 throw하는 경우까지 막아 워커 루프를 보호한다.
      }
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
   *
   * 반환값은 종결 결과다 — 어댑터 정상 반환만 `acked`이고 나머지 return 경로는 모두 `discarded`다.
   */
  private async writeWithRetry(entry: DirtyEntry): Promise<WriteOutcome> {
    // hasOwn 가드 — collection은 unconstrained string이므로 '__proto__' 등 prototype 키가
    // Object.prototype 멤버로 해석돼 undefined 가드를 우회하는 것을 막는다(security.md 동적 키 접근).
    const adapter = Object.hasOwn(this.dispatch, entry.collection)
      ? this.dispatch[entry.collection]
      : undefined
    if (adapter === undefined) {
      this.logger.error(
        { collection: entry.collection, id: entry.id },
        'write 어댑터를 찾을 수 없어 job을 폐기한다',
      )
      return 'discarded'
    }
    let attempt = 0
    for (;;) {
      try {
        await adapter(entry.id, entry.snapshot)
        return 'acked'
      } catch (error) {
        if (error instanceof DocumentNotFoundError || error instanceof ZodError) {
          // permanent — stale/삭제된 id(DocumentNotFoundError) 또는 스키마 검증 실패(ZodError,
          // snapshot 구성 버그). 재시도해도 성공하지 못하므로 fail-fast로 기록만 한다.
          this.logger.error(
            { collection: entry.collection, id: entry.id, err: error },
            'permanent write 실패 — 재시도하지 않는다',
          )
          return 'discarded'
        }
        attempt += 1
        if (attempt > this.maxRetries) {
          this.logger.error(
            { collection: entry.collection, id: entry.id, err: error, attempts: attempt },
            'transient write 재시도 소진 — job을 폐기한다',
          )
          return 'discarded'
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
