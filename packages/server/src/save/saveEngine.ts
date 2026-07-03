/**
 * 세이브 정책 엔진의 조립 컴포넌트 — DirtyTracker·AsyncWriteQueue·SaveScheduler를 하나의
 * 응집 객체로 묶고, 즉시 저장(saveNow)과 graceful shutdown seam을 노출한다.
 *
 * 조립 구조:
 *   DirtyTracker(변경 레지스트리) ─drain─▶ SaveScheduler(주기 flush) ─enqueue─▶ AsyncWriteQueue
 *   ─dispatch─▶ collection별 repo 어댑터(characters·bankAccounts→updateById, roomStates→upsert).
 *   clock·interval은 선택 주입(테스트 FakeClock, 기본 120초). AsyncWriteQueue에는 **실 logger를
 *   주입**한다(NOOP 아님) — 미주입 시 permanent·재시도소진 실패가 무흔적 폐기되므로 데이터
 *   무결성상 필수다.
 *
 * saveNow evict 근거(핵심 correctness — write-loss 봉쇄):
 *   `markDirty(K, snap_old)` 후 `saveNow(K, snap_new)`가 즉시 최신값을 쓰면, stale snap_old가
 *   두 경로로 최신 저장을 덮어쓸 수 있다(write-loss). saveNow는 write 직전에 **두 계층을 모두
 *   evict**해 둘 다 봉쇄한다(evict-before-write):
 *     (A) tracker: 아직 flush되지 않은 snap_old를 tracker.evict로 제거한다 — 이후 주기 flush의
 *         drain()이 그 키를 못 꺼내므로 재-dispatch되지 않는다.
 *     (B) queue: 이미 flush돼 큐에 있는 snap_old를 queue.evict로 제거한다 — pending이면 취소하고,
 *         워커가 in-flight로 가져간 상태면 그 write 완료를 await한 뒤 진행한다. tracker-evict만으로는
 *         (B) 경로(flush 후 in-flight)가 남아 stale 덮어쓰기가 가능하다 — 두 evict가 함께라야
 *         구조적으로 봉쇄된다.
 *   evict-before-write 순서를 택한 이유: write를 await하는 동안 도착한 더 새로운
 *   markDirty(K, snap_newer)는 evict 이후라 tracker에 그대로 남아 다음 flush로 영속화된다.
 *   write-후-evict 순서였다면 post-await evict가 그 snap_newer를 지워 유실시킨다(logic bug).
 *   write 실패 시에는 재-markDirty 없이 rethrow한다(fail-loud). 재-mark하면 snap_newer를 snap_new로
 *   덮어쓸 위험이 있고, repo 계층(DocumentNotFoundError)과 일관되게 호출자가 실패를 인지해
 *   대응하도록 둔다.
 *
 * shutdown 순서:
 *   (1) scheduler.stop() — 이후 주기 tick이 flush를 트리거하지 않는다.
 *   (2) scheduler.flush() 직접 호출 — re-entrancy flushing 플래그를 우회하는 계약(SaveScheduler
 *       doc)에 의도적으로 의존해, 진행 중이던 tick flush와 무관하게 잔여 dirty를 즉시 큐로 넘긴다.
 *   (3) queue.drain() — pending·in-flight write 완료를 대기해 종료 전 유실을 봉쇄한다.
 *   drain 타임아웃은 두지 않는다 — 큐는 capacity로 bounded돼 무한 성장이 없고, 부분 유실보다
 *   완주를 우선한다(Open Q 5). 시그널 핸들러가 무한 대기하지 않도록 상한이 필요해지면 후속 확장.
 *
 * Non-goal:
 *   메커니즘만 전달한다 — 게임플레이 호출처(레벨업·거래·로그아웃에서의 markDirty/saveNow)는
 *   여기에 추가하지 않는다. SaveEngine seam(markDirty·saveNow·start·shutdown)만 노출한다.
 */

import type { Character, BankAccount, RoomState } from 'shared'
import type { CharacterRepository } from '../repo/characterRepository.js'
import type { BankRepository } from '../repo/bankRepository.js'
import type { WorldRepository } from '../repo/worldRepository.js'
import { DirtyTracker } from './dirtyTracker.js'
import {
  AsyncWriteQueue,
  type AsyncWriteQueueOptions,
  type DispatchMap,
} from './asyncWriteQueue.js'
import { SaveScheduler, type SchedulerClock } from './saveScheduler.js'
import type { SaveLogger } from './logger.js'

/**
 * id가 비어 있지 않은 문자열인지 검증한다 — repo 어댑터가 id를 Mongo `_id` 필터에 그대로 싣기
 * 때문에, 객체가 유입되면 연산자 주입(`{$ne:...}` 등)으로 임의 문서를 대상 삼을 수 있다. money·세이브
 * 경로 진입점에서 형태를 강제해 호출자 검증에 의존하지 않는다(defense-in-depth, coding-style.md).
 */
function assertSaveId(id: string): void {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`saveNow id는 비어 있지 않은 문자열이어야 합니다: ${String(id)}`)
  }
}

/** SaveEngine 생성 옵션 — 테스트 주입 seam(clock·interval·queue). */
export interface SaveEngineOptions {
  /** 주기 flush 간격 ms(기본 DEFAULT_INTERVAL_MS=120초). */
  readonly intervalMs?: number
  /** tick seam(기본 전역 setInterval/clearInterval). 테스트는 FakeClock을 주입한다. */
  readonly clock?: SchedulerClock
  /** AsyncWriteQueue 옵션(capacity·재시도·backoff sleep seam). */
  readonly queueOptions?: AsyncWriteQueueOptions
}

export class SaveEngine {
  private readonly tracker: DirtyTracker
  private readonly queue: AsyncWriteQueue
  private readonly scheduler: SaveScheduler
  private readonly dispatch: DispatchMap
  private readonly logger: SaveLogger

  constructor(
    characterRepo: CharacterRepository,
    bankRepo: BankRepository,
    worldRepo: WorldRepository,
    logger: SaveLogger,
    options: SaveEngineOptions = {},
  ) {
    this.logger = logger
    // collection별 write 어댑터 — 즉시(saveNow)·주기(queue) 경로가 공유하는 단일 dispatch 맵.
    // roomStates는 upsert가 snapshot.roomId로 키를 결정하므로 id 인자를 무시한다.
    //
    // 호출자 계약(roomStates): dispatch write는 id를 무시하지만, DirtyTracker/evict/coalescing은
    // 여전히 `collection:id` 키로 동작한다. 따라서 roomStates 호출자는 반드시 id를 roomId에서
    // 파생한 값(`String(roomId)`)으로 넘겨야 evict·coalescing 키가 upsert가 쓰는 roomId와 정렬된다.
    // id가 어긋나면 markDirty 코얼레싱과 saveNow evict가 잘못된 키를 대상으로 삼는다.
    this.dispatch = {
      characters: (id, snapshot) =>
        characterRepo.updateById(id, snapshot as Partial<Omit<Character, '_id'>>),
      bankAccounts: (id, snapshot) =>
        bankRepo.updateById(id, snapshot as Partial<Omit<BankAccount, '_id'>>),
      roomStates: (_id, snapshot) => worldRepo.upsert(snapshot as RoomState),
    }
    this.tracker = new DirtyTracker()
    // 실 logger 주입(NOOP 아님) — 무흔적 폐기 방지.
    this.queue = new AsyncWriteQueue(this.dispatch, logger, options.queueOptions)
    this.scheduler = new SaveScheduler(this.tracker, this.queue, {
      intervalMs: options.intervalMs,
      clock: options.clock,
      logger,
    })
  }

  /**
   * collection·id 엔티티를 dirty로 기록한다(주기 flush 대상). 게임플레이 호출처는 이 seam을
   * 쓰지만, SaveEngine 자체는 호출처를 추가하지 않는다(Non-goal).
   */
  markDirty(collection: string, id: string, snapshot: unknown): void {
    this.tracker.markDirty(collection, id, snapshot)
  }

  /** 주기 flush 스케줄러를 시작한다. */
  start(): void {
    this.scheduler.start()
  }

  /**
   * 주기 버퍼를 우회해 즉시 repo write하고 await한다(fire-and-forget 금지 — 반환 시점에 문서가
   * 실제 갱신돼 있다). write 직전에 pending을 evict해 이후 주기 flush의 stale 덮어쓰기를 봉쇄한다
   * (파일 상단 "saveNow evict 근거" 참조). write 실패는 rethrow한다(fail-loud).
   *
   * reason은 관측용 파라미터다 — 알 수 없는 collection·실패 로깅 컨텍스트로만 최소 사용한다.
   */
  async saveNow(collection: string, id: string, snapshot: unknown, reason: string): Promise<void> {
    assertSaveId(id)
    // hasOwn 가드 — collection이 '__proto__' 등 prototype 키일 때 Object.prototype 멤버가 어댑터로
    // 오인돼 undefined 가드를 우회하는 것을 막는다(security.md 동적 키 접근).
    const adapter = Object.hasOwn(this.dispatch, collection) ? this.dispatch[collection] : undefined
    if (adapter === undefined) {
      this.logger.error({ collection, id, reason }, 'saveNow: 알 수 없는 collection — 폐기한다')
      return
    }
    // evict-before-write — stale 항목을 두 계층에서 제거한다(write-loss 구조적 봉쇄).
    // (A) tracker: 아직 flush 안 된 stale mark 제거. (B) queue: 이미 flush된 stale write를 취소하고
    // in-flight면 완료를 await한다(파일 상단 "saveNow evict 근거" 참조).
    this.tracker.evict(collection, id)
    await this.queue.evict(collection, id)
    try {
      await adapter(id, snapshot)
    } catch (error) {
      // 실패는 rethrow하되(fail-loud), 관측용 reason을 담아 기록한다 — 즉시 저장(로그아웃·거래
      // 등 치명 경로)의 유실을 호출자와 로그 양쪽에서 인지할 수 있게 한다.
      this.logger.error({ collection, id, reason, err: error }, 'saveNow: 즉시 저장 실패')
      throw error
    }
  }

  /**
   * graceful 종료 — scheduler 정지 → 잔여 dirty 강제 flush → queue drain 순으로 진행해 종료 전
   * pending write 유실을 막는다(파일 상단 "shutdown 순서" 참조).
   */
  async shutdown(): Promise<void> {
    this.scheduler.stop()
    // 직접 flush()는 flushing 플래그를 우회한다(SaveScheduler 계약) — 진행 중 tick flush와
    // 무관하게 잔여 dirty를 즉시 큐로 넘긴다.
    await this.scheduler.flush()
    // bounded 큐라 무제한 대기로 시작한다(타임아웃 없음) — 부분 유실보다 완주를 우선한다.
    await this.queue.drain()
  }
}
