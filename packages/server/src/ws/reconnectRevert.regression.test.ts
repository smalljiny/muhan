import { describe, it, expect, beforeEach, vi } from 'vitest'
import { isKnown, spellByNo, type Character, type ServerEvent } from 'shared'
import { DocumentNotFoundError } from '../repo/types.js'
import { characterPatchSchema } from '../repo/characterRepository.js'
import { CHARACTERS_COLLECTION } from '../world/markCharacterDirty.js'
import { goldToTrain } from '../progression/train.js'
import { SCROLL } from '../items/taxonomy.js'
import {
  BOOK_INSTANCE_ID,
  BOOK_SPELL_NO,
  BOOK_TEMPLATE,
  CHAR,
  CHAR_LEVEL,
  EXIT_EAST,
  FILLER_A,
  FILLER_B,
  KEY_BOOK,
  KEY_CHARACTER,
  KEY_FILLER_A,
  KEY_FILLER_B,
  ROOM_DEST,
  SNAPSHOT_KEYS,
  buildHarness,
  enterSession,
  expectNoSilentFallback,
  expireGrace,
  flushUntilSettled,
  liveKnowsSpell,
  makeCharacter,
  makeGate,
  storedKnowsSpell,
  studyBook,
  waitUntil,
} from './reconnectRevert.testutil.js'

/**
 * #124 회귀 스위트 — 재접속 hydrate가 미영속(write-behind) 진행도를 되돌리지 않음을 **시점별로** 고정한다.
 *
 * 스펙 §8.1·§8.2·§8.4·§8.5·§8.7·§8.10(케이스 3)·§8.11·§8.12 담당(§8.8은 형제 파일
 * `reconnectRevert.settleFailure.regression.test.ts`가 맡는다). 관통 경로는
 * `progress:study`/`progress:train` → `markCharacterDirty` → `SaveEngine`(DirtyTracker checkout/ack)
 * → `peekPending` → `hydrate` overlay → 주기 flush이며, 그 사이 어느 구간에서 grace가 만료되든
 * 진행도가 살아남는지를 본다. 시드·픽스처·하네스는 `reconnectRevert.testutil.ts`가 소유한다.
 *
 * ## 이 파일은 테스트 전용이다 — 프로덕션 코드를 바꾸지 않는다.
 *
 * ## 실 스냅샷 경로를 통과시킨다(손으로 만든 pending 리터럴 금지)
 * overlay 단위 테스트(`world/liveCharacterEntry.test.ts`)는 pending을 `{gold: 999}` 같은 리터럴로
 * 넣는다. 그 형태로는 **실제 `snapshotCharacter` 산출물이 `characterPatchSchema`(strict)를 통과하는지**
 * 를 검증하지 못한다 — 스냅샷에 스키마 밖 키가 하나 늘면 strict가 patch를 거부하고 hydrate는 `stored`로
 * 조용히 폴백해 #124가 로그 1줄만 남기고 되살아난다. 그래서 이 스위트는 전 케이스에서 실
 * `createMarkCharacterDirty`(wiring이 조립한 인스턴스)가 만든 스냅샷을 흘리고, 폴백이 회귀 통과로
 * 위장하지 못하도록 `logger.error` 0건을 함께 단언한다.
 */

describe('재접속 진행도 revert 회귀 (#124 · grace 만료 비정상 종료 경로)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('시드 비법서가 정본 objects.json에서 연마 가능한 SCROLL로 해소된다', () => {
    // 시나리오 전제를 정본 데이터에 대해 직접 고정한다 — 데이터가 바뀌면 아래 회귀들이 알 수 없는
    // 이유로 깨지는 대신 여기가 먼저 터진다.
    expect(BOOK_TEMPLATE).toBeDefined()
    expect(BOOK_TEMPLATE?.type).toBe(SCROLL)
    expect(BOOK_TEMPLATE?.ndice).toBe(CHAR_LEVEL)
    expect(BOOK_TEMPLATE?.magicpower).toBe(BOOK_SPELL_NO + 1)
    expect(spellByNo(BOOK_SPELL_NO)).toBeDefined()
  })

  // ── §8.1 study 교차 키 ──────────────────────────────────────────────────────
  it('§8.1 — study 후 graceExpired로 끊겼다 재접속·이동해도 주문이 살아남고 비법서는 삭제된다', async () => {
    const h = buildHarness()
    h.saveEngine.start()

    await enterSession(h)
    const studied = studyBook(h)
    expect(studied).toMatchObject({ type: 'progress:studied', spellNo: BOOK_SPELL_NO })

    // 비정상 종료(grace 만료). 정상 로그아웃 경로가 아니다 — §8.12.
    expireGrace(h)
    expect(h.liveRegistry.get(CHAR)).toBeUndefined()
    // 대조 앵커: 저장소는 아직 stale하다(아래 네 단언이 vacuous하지 않음을 보장한다).
    expect(storedKnowsSpell(h)).toBe(false)

    // ① 재접속 직후 — 라이브 캐릭터에 주문이 학습돼 있다.
    const live = await h.wiring.liveWorldBinding.entry.hydrate(CHAR)
    h.wiring.liveWorldBinding.entry.place(live)
    expect(isKnown(live.character.spells, BOOK_SPELL_NO)).toBe(true)

    // ② 이동 1회 후 — stale 재-mark가 학습을 덮지 않았다.
    const moved = h.move({ type: 'world:move', direction: EXIT_EAST })
    expect(moved).toMatchObject({ type: 'world:room', roomId: ROOM_DEST })
    expect(liveKnowsSpell(h)).toBe(true)
    // 이동이 **마킹한 스냅샷**에도 주문이 실려 있다. 라이브 객체만 보면 다음 flush가 무엇을 쓸지는
    // 알 수 없다 — 되돌림은 라이브가 아니라 마킹된 스냅샷에서 일어난다.
    const pendingAfterMove = characterPatchSchema.parse(
      h.saveEngine.peekPending(CHARACTERS_COLLECTION, CHAR),
    )
    expect(isKnown(pendingAfterMove.spells ?? [], BOOK_SPELL_NO)).toBe(true)

    // ③④ flush 후 — 영속 문서에 주문이 남고, 비법서 인스턴스는 삭제됐다.
    await flushUntilSettled(h, [KEY_CHARACTER, KEY_BOOK])
    expect(storedKnowsSpell(h)).toBe(true)
    expect(h.docs.get(CHAR)?.currentRoom).toBe(ROOM_DEST)
    expect(h.objects.has(BOOK_INSTANCE_ID)).toBe(false)
    expect(h.objectRepo.deleteById).toHaveBeenCalledWith(BOOK_INSTANCE_ID)

    expectNoSilentFallback(h)
    expect(h.saveLogger.error).not.toHaveBeenCalled()
  })

  // ── §8.2 train 단일 키 ──────────────────────────────────────────────────────
  it('§8.2 — train 후 graceExpired로 끊겼다 재접속·이동해도 level·gold·exp·vitals·stats가 연마 결과값이다', async () => {
    const h = buildHarness()
    h.saveEngine.start()

    await enterSession(h)
    const trained = h.train({ type: 'progress:train' })
    expect(trained).toMatchObject({ type: 'progress:trained', levelsGained: 1 })

    // 기대값은 손으로 계산하지 않고 연마 결과 이벤트에서 파생한다 — 성장 공식(upLevel·resync)의 단일
    // 출처는 shared이고, 재유도하면 이 회귀가 그 공식의 복제본을 검증하게 된다.
    const event = trained as Extract<ServerEvent, { type: 'progress:trained' }>
    const expected = {
      level: event.level,
      experience: event.experience,
      gold: event.gold,
      hpCurrent: event.hpCurrent,
      mpCurrent: event.mpCurrent,
      stats: event.stats,
    }
    // 대조 앵커: 연마가 실제로 값을 움직였다(모든 시점 단언이 시드값과 같아 통과하는 일이 없다).
    expect(expected.level).toBe(CHAR_LEVEL + 1)
    expect(h.docs.get(CHAR)).toMatchObject({ level: CHAR_LEVEL, gold: goldToTrain(CHAR_LEVEL) })

    expireGrace(h)

    // ① 재접속 직후
    const live = await h.wiring.liveWorldBinding.entry.hydrate(CHAR)
    h.wiring.liveWorldBinding.entry.place(live)
    expect(live.character).toMatchObject(expected)

    // ② 이동 후
    expect(h.move({ type: 'world:move', direction: EXIT_EAST })).toMatchObject({
      type: 'world:room',
    })
    expect(h.liveRegistry.get(CHAR)?.character).toMatchObject(expected)

    // ③ flush 후
    await flushUntilSettled(h, [KEY_CHARACTER])
    expect(h.docs.get(CHAR)).toMatchObject({ ...expected, currentRoom: ROOM_DEST })

    expectNoSilentFallback(h)
  })

  // ── 실 스냅샷 경로 관통(리뷰 지적 — 미검증 가정) ────────────────────────────
  it('실 markCharacterDirty 스냅샷이 characterPatchSchema를 통과해 overlay까지 도달한다(조용한 폴백 0건)', async () => {
    // 지금까지의 overlay 테스트는 pending을 손으로 만든 리터럴(`{gold: 999}`)로 넣어, **실
    // snapshotCharacter 산출물이 strict 스키마를 통과한다**는 가정을 아무도 검증하지 않았다. 스냅샷에
    // 스키마 밖 키가 하나 늘면 safeParse가 실패하고 hydrate는 error 로그 1줄만 남긴 채 stored로
    // 폴백한다 — #124가 예외 없이 되살아난다. 이 케이스가 그 가정을 실 경로로 못박는다.
    const h = buildHarness()
    h.saveEngine.start()

    await enterSession(h)
    studyBook(h)
    expireGrace(h)

    const pending = h.saveEngine.peekPending(CHARACTERS_COLLECTION, CHAR)
    expect(pending).toBeDefined()
    // (1) 실 스냅샷이 영속 경로와 **같은 스키마 인스턴스**를 통과한다.
    const parsed = characterPatchSchema.safeParse(pending)
    expect(parsed.success).toBe(true)
    // (2) 키 집합이 기대와 정확히 일치한다 — `_id`는 stripImmutableId가, `status`는 snapshotCharacter가 뺀다.
    expect(Object.keys(pending as object).sort()).toEqual(SNAPSHOT_KEYS)

    const storedBefore = structuredClone(h.docs.get(CHAR))
    const live = await h.wiring.liveWorldBinding.entry.hydrate(CHAR)

    // (3) hydrate가 본 pending이 위에서 검사한 바로 그 값이다(다른 경로로 새 값이 만들어지지 않았다).
    //     참조 동일성으로는 볼 수 없다 — peekPending은 `stripImmutableId`가 만든 새 객체를 매 호출
    //     돌려주므로(`_id`를 벗긴 사본) 값 동등으로 대조한다.
    const observed = h.peekLog.at(-1)
    expect(observed).toMatchObject({ collection: CHARACTERS_COLLECTION, id: CHAR })
    expect(observed?.value).toEqual(pending)

    // (4) overlay가 실제로 적용됐다 — stored와 다르고, pending의 모든 키가 결과에 반영됐다.
    expect(live.character).not.toEqual(storedBefore)
    for (const key of SNAPSHOT_KEYS) {
      expect(live.character[key as keyof Character]).toEqual(
        (pending as Record<string, unknown>)[key],
      )
    }
    // `_id`는 pending 값이 아니라 요청한 characterId로 고정된다.
    expect(live.character._id).toBe(CHAR)

    // (5) 조용한 폴백이 회귀 통과로 위장하지 않는다.
    expectNoSilentFallback(h)
  })

  // ── §8.4 backpressure handoff ──────────────────────────────────────────────
  it('§8.4 — 큐 capacity 포화로 enqueue가 대기하는 동안 graceExpired·재접속해도 §8.1 네 단언이 성립한다', async () => {
    // capacity 1: checkout 배열의 첫 항목만 pending에 들어가고 나머지는 enqueue에서 block한다.
    // 대상 키(characters:CHAR)를 그 대기 구간에 두려면 filler 2건을 **먼저** 마킹해야 한다
    // (checkout 순서 = DirtyTracker Map 삽입 순서).
    const h = buildHarness({ capacity: 1 })
    h.saveEngine.start()

    await enterSession(h)
    h.wiring.markCharacterDirty(FILLER_A, makeCharacter({ _id: FILLER_A }))
    h.wiring.markCharacterDirty(FILLER_B, makeCharacter({ _id: FILLER_B }))

    // filler A의 write를 붙잡아 단일 워커를 점유시킨다.
    const writeGate = makeGate()
    h.controls.writeGates.set(FILLER_A, writeGate)

    studyBook(h)
    h.clock.tick()
    await waitUntil(
      () => h.characterRepo.updateById.mock.calls.some(([id]) => id === FILLER_A),
      'filler A write가 in-flight로 진입',
    )

    // 이 시점 상태: filler A = in-flight(게이트 대기), filler B = pending,
    // characters:CHAR·objectDeletions:BOOK = **checkout됐지만 enqueue 수락 전**(capacity 대기).
    // 스냅샷이 그 구간에서도 조회된다는 것이 수명 계약의 요점이다(스펙 §8.3 구간 ②의 관통 실증).
    const blockedPending = characterPatchSchema.parse(
      h.saveEngine.peekPending(CHARACTERS_COLLECTION, CHAR),
    )
    expect(isKnown(blockedPending.spells ?? [], BOOK_SPELL_NO)).toBe(true)
    expect(storedKnowsSpell(h)).toBe(false)

    // 대기 중 grace 만료 → 재접속.
    //
    // ⚠ 관측 범위를 정확히 적어 둔다: `onSessionEnd`가 종료 스냅샷을 한 번 더 마킹하므로, 바로 위
    // 단언이 본 "checkout됐지만 enqueue 대기 중"인 스냅샷은 여전히 in-flight 배치에 남아 있고
    // hydrate는 그보다 새로운 registry 스냅샷을 집는다(peek의 registry 우선 규칙). 즉 이 케이스가
    // 고정하는 것은 두 가지다 — (a) 대기 구간의 스냅샷도 tracker에서 사라지지 않는다(위 단언),
    // (b) 그 구간에서 재접속해도 네 단언이 성립한다(아래). 대기 스냅샷이 **유일 사본**인 상태는
    // 라이브 경로에 존재하지 않는다(종료 경계가 항상 재마킹한다).
    expireGrace(h)
    const live = await h.wiring.liveWorldBinding.entry.hydrate(CHAR)
    h.wiring.liveWorldBinding.entry.place(live)
    expect(isKnown(live.character.spells, BOOK_SPELL_NO)).toBe(true) // ①

    expect(h.move({ type: 'world:move', direction: EXIT_EAST })).toMatchObject({
      type: 'world:room',
      roomId: ROOM_DEST,
    })
    expect(liveKnowsSpell(h)).toBe(true) // ②

    // 게이트를 열어 막힌 배치를 흘려보내고 후속 flush까지 종결시킨다.
    writeGate.open()
    await flushUntilSettled(h, [KEY_CHARACTER, KEY_BOOK, KEY_FILLER_A, KEY_FILLER_B])

    expect(storedKnowsSpell(h)).toBe(true) // ③
    expect(h.docs.get(CHAR)?.currentRoom).toBe(ROOM_DEST)
    expect(h.objects.has(BOOK_INSTANCE_ID)).toBe(false) // ④
    expectNoSilentFallback(h)
  })

  // ── §8.5 TOCTOU 결정적 인터리빙 ────────────────────────────────────────────
  it('§8.5 — findById가 지연되는 사이 in-flight write가 완료·ack돼도 재접속 진행도가 보존된다', async () => {
    const h = buildHarness()
    h.saveEngine.start()

    await enterSession(h)
    studyBook(h)
    expireGrace(h)
    expect(storedKnowsSpell(h)).toBe(false)

    // findById를 게이트로 붙잡는다. 페이크는 **호출 시점에 문서를 캡처**하므로, 게이트가 열릴 때
    // 돌려주는 값은 그 사이 완료된 write를 담지 않는다(실 DB 읽기의 스냅샷 격리와 같다).
    const readGate = makeGate()
    h.controls.findByIdGate = readGate

    const hydrating = h.wiring.liveWorldBinding.entry.hydrate(CHAR)
    await waitUntil(
      () => h.characterRepo.findById.mock.calls.length === 2,
      '재접속 findById가 발행됨',
    )

    // 선형화 지점: peekPending이 findById보다 먼저 발화했다.
    expect(h.callOrder).toEqual([
      `peekPending:${CHARACTERS_COLLECTION}:${CHAR}`,
      `findById:${CHAR}`,
      `peekPending:${CHARACTERS_COLLECTION}:${CHAR}`,
      `findById:${CHAR}`,
    ])

    // 역방향 레이스(peek 이후 새 markDirty)가 도달 불가임을 이 시점에서 직접 단언한다 —
    // liveRegistry 미스라 이 characterId의 writer가 0개다. 명령이 와도 라이브 미등록으로 격리되어
    // 마킹을 유발하지 못한다.
    expect(h.peekLog.at(-1)?.liveRegistered).toBe(false)
    expect(h.liveRegistry.get(CHAR)).toBeUndefined()
    const pendingBeforeInert = h.saveEngine.peekPending(CHARACTERS_COLLECTION, CHAR)
    expect(h.move({ type: 'world:move', direction: EXIT_EAST })).toMatchObject({
      type: 'error',
      code: 'internal',
    })
    // 값 동등으로 본다 — peekPending은 매 호출 `_id`를 벗긴 새 사본을 돌려주므로 참조는 항상 다르다.
    expect(h.saveEngine.peekPending(CHARACTERS_COLLECTION, CHAR)).toEqual(pendingBeforeInert)

    // 그 사이 in-flight write를 완료·ack시킨다 — pending이 사라진다.
    await flushUntilSettled(h, [KEY_CHARACTER, KEY_BOOK])
    expect(h.saveEngine.peekPending(CHARACTERS_COLLECTION, CHAR)).toBeUndefined()

    // 이제 게이트를 연다. findById는 write **이전에** 캡처한 stale 문서를 돌려준다.
    readGate.open()
    h.controls.findByIdGate = null
    const live = await hydrating
    h.wiring.liveWorldBinding.entry.place(live)
    expect(isKnown(live.character.spells, BOOK_SPELL_NO)).toBe(true) // ①

    expect(h.move({ type: 'world:move', direction: EXIT_EAST })).toMatchObject({
      type: 'world:room',
      roomId: ROOM_DEST,
    })
    expect(liveKnowsSpell(h)).toBe(true) // ②

    await flushUntilSettled(h, [KEY_CHARACTER, KEY_BOOK])
    // ③ 이동이 마킹한 스냅샷이 stale이었다면 여기서 주문이 사라진다.
    expect(storedKnowsSpell(h)).toBe(true)
    expect(h.docs.get(CHAR)?.currentRoom).toBe(ROOM_DEST)
    expect(h.objects.has(BOOK_INSTANCE_ID)).toBe(false) // ④
    expectNoSilentFallback(h)
  })

  // ── §8.7 성공 ack 후 조회 ──────────────────────────────────────────────────
  it('§8.7 — 성공 ack 후 peekPending이 undefined이고 같은 시점 findById가 write된 값을 돌려준다', async () => {
    const h = buildHarness()
    h.saveEngine.start()

    await enterSession(h)
    studyBook(h)
    expireGrace(h)
    expect(h.saveEngine.peekPending(CHARACTERS_COLLECTION, CHAR)).toBeDefined()

    await flushUntilSettled(h, [KEY_CHARACTER, KEY_BOOK])

    // `undefined` 불변식의 실증: 미영속 스냅샷이 없다는 말은 저장소 문서가 최신이라는 뜻이다.
    expect(h.saveEngine.peekPending(CHARACTERS_COLLECTION, CHAR)).toBeUndefined()
    const persisted = await h.characterRepo.findById(CHAR)
    expect(isKnown(persisted?.spells ?? [], BOOK_SPELL_NO)).toBe(true)
  })

  // ── §8.10 케이스 3 ─────────────────────────────────────────────────────────
  it('§8.10 케이스 3 — overlay에 적용된 필드 집합이 flush가 $set한 필드 집합과 일치한다', async () => {
    const h = buildHarness()
    h.saveEngine.start()

    await enterSession(h)
    studyBook(h)
    expireGrace(h)

    const live = await h.wiring.liveWorldBinding.entry.hydrate(CHAR)
    h.wiring.liveWorldBinding.entry.place(live)

    // hydrate가 실제로 본 pending 객체에서 overlay 대상 키를 얻는다(별도 재유도 금지).
    const observed = h.peekLog.at(-1)?.value as Record<string, unknown>
    const overlayKeys = Object.keys(observed).sort()
    expect(overlayKeys).toEqual(SNAPSHOT_KEYS)
    // 그 키들이 **실제로 덮였다**. 이 단언이 없으면 overlay를 통째로 들어내도 두 키 집합은 여전히
    // 같아(둘 다 같은 정규화를 거친 스냅샷의 키다) 테스트가 조용히 통과한다.
    for (const key of overlayKeys) {
      expect(live.character[key as keyof Character]).toEqual(observed[key])
    }
    expect(isKnown(live.character.spells, BOOK_SPELL_NO)).toBe(true)
    // vacuous 방지: 두 집합이 모두 비어 있어 일치하는 상황을 배제한다.
    expect(overlayKeys).toContain('spells')
    expect(overlayKeys).toContain('gold')
    expect(overlayKeys).toContain('currentRoom')
    // 정규화가 양쪽에서 같은 키를 뺀다.
    expect(overlayKeys).not.toContain('_id')
    expect(overlayKeys).not.toContain('status')

    await flushUntilSettled(h, [KEY_CHARACTER, KEY_BOOK])

    const patch = h.characterRepo.updateById.mock.calls.at(-1)?.[1]
    expect(patch).toBeDefined()
    expect(Object.keys(patch as object).sort()).toEqual(overlayKeys)
    expectNoSilentFallback(h)
  })

  // ── §8.11 영구 실패 경로 ───────────────────────────────────────────────────
  it('§8.11 — permanent 폐기 후 peekPending이 undefined이고 hydrate가 stored를 채택한다(보장 범위 밖)', async () => {
    const h = buildHarness()
    h.saveEngine.start()

    await enterSession(h)
    studyBook(h)
    expireGrace(h)

    // characters write만 permanent 실패로 폐기시킨다(재시도 없음 — DocumentNotFoundError).
    h.controls.writeFailures.set(CHAR, new DocumentNotFoundError(CHARACTERS_COLLECTION, CHAR))
    await flushUntilSettled(h, [KEY_CHARACTER, KEY_BOOK])

    // 폐기는 inProgress에서도 제거된다 — 누수가 없다.
    expect(h.saveEngine.peekPending(CHARACTERS_COLLECTION, CHAR)).toBeUndefined()
    // 무흔적 폐기가 아니다.
    expect(h.saveLogger.error).toHaveBeenCalled()

    const live = await h.wiring.liveWorldBinding.entry.hydrate(CHAR)
    // 스냅샷은 복구되지 않는다 — hydrate가 저장소 문서를 그대로 쓴다(보장 범위 밖임을 고정).
    expect(isKnown(live.character.spells, BOOK_SPELL_NO)).toBe(false)
    expect(live.character).toEqual(h.docs.get(CHAR))
    // overlay를 시도조차 하지 않았으므로 검증 실패 로그도 없다.
    expectNoSilentFallback(h)
  })

  // ── §8.12 경로 조건 ────────────────────────────────────────────────────────
  // 아래 케이스는 대응표상 Story 4 몫(pending 없는 정상 경로)이다. Story 5가 맡은 §8.12
  // (회귀가 graceExpired 비정상 종료 경로를 덮는다)는 이 describe 전체가 expireGrace로만
  // 시나리오를 여는 것으로 충족된다.
  it('§8.12 — pending이 없는 경로에서 hydrate 결과가 저장소 문서와 동일하다(회귀 없음)', async () => {
    const h = buildHarness()
    h.saveEngine.start()

    await enterSession(h)
    studyBook(h)
    expireGrace(h)
    // 재접속 **전에** 전부 영속화한다 — 이 경로에는 미영속 스냅샷이 없다.
    await flushUntilSettled(h, [KEY_CHARACTER, KEY_BOOK])
    expect(h.saveEngine.peekPending(CHARACTERS_COLLECTION, CHAR)).toBeUndefined()

    const live = await h.wiring.liveWorldBinding.entry.hydrate(CHAR)
    expect(live.character).toEqual(h.docs.get(CHAR))
    expectNoSilentFallback(h)
  })
})
