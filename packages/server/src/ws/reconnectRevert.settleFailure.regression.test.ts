import { describe, it, expect, vi } from 'vitest'
import { isKnown, setKnown, type Character } from 'shared'
import { AsyncWriteQueue } from '../save/asyncWriteQueue.js'
import { DirtyTracker } from '../save/dirtyTracker.js'
import { SaveScheduler } from '../save/saveScheduler.js'
import { FakeClock } from '../util/clock.testutil.js'
import { createLiveCharacterRegistry } from '../world/liveCharacterRegistry.js'
import { createLiveCharacterEntry } from '../world/liveCharacterEntry.js'
import { CHARACTERS_COLLECTION, createMarkCharacterDirty } from '../world/markCharacterDirty.js'
import { makeRoom } from '../world/roomFixtures.testutil.js'
import {
  BOOK_SPELL_NO,
  CHAR,
  FILLER_A,
  ROOM_TRAIN,
  createFakeRepos,
  makeCharacter,
  waitUntil,
  type Controls,
  type Gate,
} from './reconnectRevert.testutil.js'

/**
 * `saveEngine.ts`의 모듈 비공개 `stripImmutableId` 미러.
 *
 * 그 함수는 export되지 않으므로(스펙 §3.2 — 영속 경로와 조회 경로가 같은 인스턴스를 공유하되 표면은
 * 넓히지 않는다) 테스트가 같은 정규화를 재현한다. §8.8 하네스가 `SaveEngine`을 우회해 큐를 직접
 * 조립하기 때문에 그 한 곳에서만 쓰인다.
 */
function stripImmutableId(snapshot: unknown): unknown {
  if (typeof snapshot !== 'object' || snapshot === null || !('_id' in snapshot)) return snapshot
  const { _id: _immutable, ...rest } = snapshot as Record<string, unknown>
  return rest
}

/**
 * §8.8 — 완료 통지(onSettled)가 throw해 엔트리가 `inProgress`에 잔류한 상태의 hydrate 측 귀결.
 *
 * ## 왜 SaveEngine을 쓰지 않는가
 * `SaveEngineOptions.queueOptions`는 `Omit<AsyncWriteQueueOptions, 'onSettled'>`다 — 엔진이 그 seam으로
 * tracker 반납을 배선하므로 호출자 주입을 **타입으로 막았다**(Story 2 결정). 따라서 통지 실패는
 * SaveEngine 경유로 도달 불가하고, 이 케이스만 엔진과 같은 형태로 큐·트래커·스케줄러를 직접 조립한다.
 * 검증 대상은 엔진의 배선이 아니라 **잔류 상태에서 hydrate가 안전하게 실패하는가**이므로 범위가 맞다.
 */
describe('§8.8 완료 통지 실패로 잔류한 스냅샷의 hydrate 측 귀결', () => {
  it('엔트리가 inProgress에 잔류해도 hydrate 결과가 DB 문서와 일치하고 워커는 생존한다', async () => {
    const controls: Controls = {
      findByIdGate: null,
      writeGates: new Map<string, Gate>(),
      writeFailures: new Map<string, Error>(),
    }
    const { docs, characterRepo } = createFakeRepos(controls)
    docs.set(CHAR, makeCharacter())
    docs.set(FILLER_A, makeCharacter({ _id: FILLER_A }))

    const clock = new FakeClock()
    const saveLogger = { error: vi.fn() }
    const tracker = new DirtyTracker()
    const queue = new AsyncWriteQueue(
      {
        // SaveEngine의 characters 어댑터와 같은 형태 — 영속 경로에서 `_id`를 벗긴다.
        [CHARACTERS_COLLECTION]: (id, snapshot) =>
          characterRepo.updateById(id, stripImmutableId(snapshot) as Partial<Character>),
      },
      saveLogger,
      {
        sleep: () => Promise.resolve(),
        // 반납 배선이 통째로 실패하는 상황을 주입한다.
        onSettled: () => {
          throw new Error('완료 통지 처리기 실패 주입')
        },
      },
    )
    const scheduler = new SaveScheduler(tracker, queue, { clock, logger: saveLogger })

    const liveRegistry = createLiveCharacterRegistry()
    const logger = { warn: vi.fn(), error: vi.fn() }
    const room = makeRoom({ roomId: ROOM_TRAIN })
    const entry = createLiveCharacterEntry({
      characterRepo: {
        findById: (id) => characterRepo.findById(id),
        hydrateInventory: (id) => characterRepo.hydrateInventory(id),
      },
      liveRegistry,
      resolveRoom: (roomId) => (roomId === ROOM_TRAIN ? room : undefined),
      onRoomEntered: vi.fn(),
      onRoomLeft: vi.fn(),
      // SaveEngine.peekPending과 같은 정규화(`stripImmutableId`)를 적용한 조회 seam.
      peekPendingCharacter: (id) =>
        stripImmutableId(tracker.peek(CHARACTERS_COLLECTION, id)?.snapshot),
      logger,
    })
    const markCharacterDirty = createMarkCharacterDirty((collection, id, snapshot) => {
      tracker.markDirty(collection, id, snapshot)
    })

    // 학습 결과를 실 스냅샷 헬퍼로 마킹한다(손으로 만든 pending 리터럴 금지). 지식 비트도 손으로
    // 계산하지 않고 정본 `setKnown`을 쓴다 — 비트 배치의 단일 출처는 shared다.
    const learned = makeCharacter({ spells: setKnown(makeCharacter().spells, BOOK_SPELL_NO) })
    markCharacterDirty(CHAR, learned)

    scheduler.start()
    clock.tick()
    await waitUntil(
      () => characterRepo.updateById.mock.calls.some(([id]) => id === CHAR),
      'characters write 완료',
    )
    await queue.drain()

    // write는 성공했지만 반납 통지가 실패했다 — 엔트리가 inProgress에 남는다(정의된 동작).
    expect(tracker.inProgressSize).toBe(1)
    expect(tracker.peek(CHARACTERS_COLLECTION, CHAR)).toBeDefined()
    // 무흔적이 아니다 — 큐가 통지 실패를 기록한다.
    // 통지 실패 자체를 집었는지 고정한다 — toHaveBeenCalled()만 두면 세이브 계층의 아무 오류
    // 로그에나 통과해, 정작 검증 대상인 onSettled throw가 사라져도 초록불이 된다.
    expect(saveLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'acked' }),
      expect.any(String),
    )
    // DB에는 이미 그 값이 들어갔다.
    expect(isKnown(docs.get(CHAR)?.spells ?? [], BOOK_SPELL_NO)).toBe(true)

    // 안전한 실패: 잔류 스냅샷을 overlay해도 결과가 DB 문서와 일치한다(과거로 되돌리지 않는다).
    const live = await entry.hydrate(CHAR)
    expect(live.character).toEqual(docs.get(CHAR))
    expect(logger.error).not.toHaveBeenCalled()

    // 워커가 생존해 후속 job을 계속 처리한다.
    markCharacterDirty(FILLER_A, makeCharacter({ _id: FILLER_A, gold: 7 }))
    clock.tick()
    await waitUntil(
      () => characterRepo.updateById.mock.calls.some(([id]) => id === FILLER_A),
      'filler write 처리(워커 생존)',
    )
    await queue.drain()
    expect(docs.get(FILLER_A)?.gold).toBe(7)

    // 누수는 무한이 아니다 — 같은 키의 다음 checkout이 inProgress 엔트리를 덮어쓴다.
    markCharacterDirty(CHAR, makeCharacter({ gold: 3 }))
    clock.tick()
    await waitUntil(() => docs.get(CHAR)?.gold === 3, '같은 키 재-mark가 다음 flush로 영속화')
    await queue.drain()
    expect(tracker.inProgressSize).toBe(2) // characters:CHAR·characters:FILLER_A 각 1건(키당 1건 상한)
    scheduler.stop()
  })
})
