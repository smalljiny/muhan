import { describe, it, expect, vi } from 'vitest'
import type { RoomNode } from 'shared'
import { makeCreature, makeRoom, flagsHex, NO_FLAGS } from './roomFixtures.testutil.js'
import { PDMINV, PDINVI, MINVIS } from './hexFlags.js'
import { resolveRoomCreature, createRoomPlayerResolver } from './roomTargetResolvers.js'

/**
 * 방 스코프 해소자 2종 — 오라클 `creature.c:29-60 find_crt`의 가시성 게이트 + 순수 매처 위임.
 *
 * 게이트가 `match++` **앞**에 있다는 것이 이 테스트 스위트의 핵심 단정이다 — 걸린 후보는 서수
 * 슬롯을 소모하지 않는다. 서수 케이스는 게이트를 mock으로 제거하지 않고 실제 게이트를 통과하는
 * 입력으로 구성한다(`.harness/rules/testing.md` 다층 guard 원칙).
 */

/** CARETAKER(초인) 클래스 인덱스 — mtype.h:103. 테스트가 구현 상수를 재사용하지 않고 독립 전사한다. */
const CARETAKER_CLASS = 10

function roomWithCreatures(...creatures: RoomNode['creatures']): RoomNode {
  return makeRoom({ creatures })
}

describe('resolveRoomCreature — DM 투명 게이트(class >= CARETAKER && PDMINV 결합)', () => {
  it('class >= CARETAKER이고 PDMINV면 후보에서 스킵한다', () => {
    const room = roomWithCreatures(
      makeCreature('c-dm', '고블린', { class: CARETAKER_CLASS, flags: flagsHex(PDMINV) }),
      makeCreature('c-normal', '고블린'),
    )

    expect(resolveRoomCreature(room, '고블린', NO_FLAGS)?.instanceId).toBe('c-normal')
  })

  it('class = CARETAKER이지만 PDMINV 미보유면 후보로 남는다(결합 조건 — 실측 52마리 미스킵 lock)', () => {
    const room = roomWithCreatures(
      makeCreature('c-caretaker', '고블린', { class: CARETAKER_CLASS, flags: NO_FLAGS }),
    )

    expect(resolveRoomCreature(room, '고블린', NO_FLAGS)?.instanceId).toBe('c-caretaker')
  })

  it('PDMINV 보유지만 class < CARETAKER면 후보로 남는다(결합 조건 반대 방향)', () => {
    const room = roomWithCreatures(
      makeCreature('c-invis-dm', '고블린', {
        class: CARETAKER_CLASS - 1,
        flags: flagsHex(PDMINV),
      }),
    )

    expect(resolveRoomCreature(room, '고블린', NO_FLAGS)?.instanceId).toBe('c-invis-dm')
  })

  it('DM 투명 후보는 서수 슬롯도 소모하지 않는다(게이트가 match++ 앞)', () => {
    const room = roomWithCreatures(
      makeCreature('c-dm', '고블린', { class: CARETAKER_CLASS, flags: flagsHex(PDMINV) }),
      makeCreature('c-1', '고블린'),
      makeCreature('c-2', '고블린'),
    )

    expect(resolveRoomCreature(room, '고블린', NO_FLAGS, 1)?.instanceId).toBe('c-1')
    expect(resolveRoomCreature(room, '고블린', NO_FLAGS, 2)?.instanceId).toBe('c-2')
    expect(resolveRoomCreature(room, '고블린', NO_FLAGS, 3)).toBeUndefined()
  })
})

describe('resolveRoomCreature — MINVIS 게이트와 관찰자 PDINVI 예외', () => {
  it('MINVIS 크리처는 PDINVI 미보유 관찰자에게 해소되지 않는다', () => {
    const room = roomWithCreatures(makeCreature('c-invis', '유령', { flags: flagsHex(MINVIS) }))

    expect(resolveRoomCreature(room, '유령', NO_FLAGS)).toBeUndefined()
  })

  it('MINVIS 크리처도 PDINVI 보유 관찰자에게는 해소된다', () => {
    const room = roomWithCreatures(makeCreature('c-invis', '유령', { flags: flagsHex(MINVIS) }))

    expect(resolveRoomCreature(room, '유령', flagsHex(PDINVI))?.instanceId).toBe('c-invis')
  })

  it('MINVIS 없는 크리처는 관찰자 flags와 무관하게 해소된다', () => {
    const room = roomWithCreatures(makeCreature('c-plain', '유령'))

    expect(resolveRoomCreature(room, '유령', NO_FLAGS)?.instanceId).toBe('c-plain')
    expect(resolveRoomCreature(room, '유령', flagsHex(PDINVI))?.instanceId).toBe('c-plain')
  })
})

describe('resolveRoomCreature — 서수 × 가시성 교차', () => {
  // 세 후보가 **같은 질의에 전부 매치**해야 필터-후-매칭 구현(매칭 뒤 게이트 적용)이 실패한다.
  const invisibleMiddle = (): RoomNode =>
    roomWithCreatures(
      makeCreature('c-a', '고블린'),
      makeCreature('c-b', '고블린', { flags: flagsHex(MINVIS) }),
      makeCreature('c-c', '고블린'),
    )

  it('PDINVI 미보유 관찰자에게 ordinal=2는 숨은 B를 건너뛰고 C를 준다', () => {
    expect(resolveRoomCreature(invisibleMiddle(), '고블린', NO_FLAGS, 2)?.instanceId).toBe('c-c')
  })

  it('PDINVI 미보유 관찰자에게 ordinal=3은 미달이다(숨은 후보가 슬롯을 채우지 않음)', () => {
    expect(resolveRoomCreature(invisibleMiddle(), '고블린', NO_FLAGS, 3)).toBeUndefined()
  })

  it('PDINVI 보유 관찰자에게는 같은 방에서 ordinal=2가 B를 준다(예외 통과로 슬롯 복원)', () => {
    const observer = flagsHex(PDINVI)
    expect(resolveRoomCreature(invisibleMiddle(), '고블린', observer, 2)?.instanceId).toBe('c-b')
    expect(resolveRoomCreature(invisibleMiddle(), '고블린', observer, 3)?.instanceId).toBe('c-c')
  })
})

describe('resolveRoomCreature — 매칭 규칙은 순수 매처에 위임한다', () => {
  it('별칭(keys)으로만 일치하는 후보도 해소된다', () => {
    const room = roomWithCreatures(makeCreature('c-1', '작은 거미', { keys: ['거미'] }))

    expect(resolveRoomCreature(room, '거미', NO_FLAGS)?.instanceId).toBe('c-1')
  })

  it('접두가 아니면 해소되지 않고, ordinal 기본값은 1이다', () => {
    const room = roomWithCreatures(makeCreature('c-1', '고블린'), makeCreature('c-2', '고블린'))

    expect(resolveRoomCreature(room, '오크', NO_FLAGS)).toBeUndefined()
    expect(resolveRoomCreature(room, '고블린', NO_FLAGS)?.instanceId).toBe('c-1')
  })

  it('입력 방·크리처 배열을 변형하지 않는다(순수)', () => {
    const room = roomWithCreatures(
      makeCreature('c-dm', '고블린', { class: CARETAKER_CLASS, flags: flagsHex(PDMINV) }),
      makeCreature('c-1', '고블린'),
    )
    const before = room.creatures.map((c) => c.instanceId)

    resolveRoomCreature(room, '고블린', NO_FLAGS, 2)

    expect(room.creatures.map((c) => c.instanceId)).toEqual(before)
  })
})

describe('createRoomPlayerResolver', () => {
  const names: Record<string, string> = {
    'char-1': '테스토스',
    'char-2': '테이',
    'char-3': '타이',
  }
  const resolveName = (characterId: string): string | undefined => names[characterId]

  it('occupants 이름 접두로 characterId를 해소한다', () => {
    const resolve = createRoomPlayerResolver(resolveName)
    const room = makeRoom({ occupants: new Set(['char-1', 'char-2', 'char-3']) })

    expect(resolve(room, '테스')).toBe('char-1')
    expect(resolve(room, '타')).toBe('char-3')
    expect(resolve(room, '없는이름')).toBeUndefined()
  })

  it('ordinal을 크리처 해소자와 동일 규칙으로 처리한다(도착 순서 = 서수 기준)', () => {
    const resolve = createRoomPlayerResolver(resolveName)
    const room = makeRoom({ occupants: new Set(['char-1', 'char-2']) })

    expect(resolve(room, '테')).toBe('char-1')
    expect(resolve(room, '테', 1)).toBe('char-1')
    expect(resolve(room, '테', 2)).toBe('char-2')
    expect(resolve(room, '테', 3)).toBeUndefined()
  })

  // 알려진 divergence(모듈 헤더 참조) — 오라클 `add_ply_rom`(room.c:58-72)은 first_ply에 strcmp
  // 이름 정렬로 삽입하므로 서수가 사전순이다. 이 포트는 도착 순서를 쓴다. EUC-KR strcmp 순서는
  // JS 문자열 비교로 재현되지 않아 정렬을 넣지 않았고, 그 선택을 여기서 고정한다 — 누가 `.sort()`를
  // 넣으면 이 테스트가 깨지고, 그때 collation 이식 여부를 의식적으로 결정하게 된다.
  it('서수는 도착 순서를 따른다 — 오라클의 이름 정렬 삽입과 의도적으로 다르다', () => {
    const resolve = createRoomPlayerResolver(resolveName)
    // 사전순이라면 '테스토스'(char-1)보다 '테이'(char-2)가 앞설 수 있으나, 도착 순서는 char-2가 먼저다.
    const room = makeRoom({ occupants: new Set(['char-2', 'char-1']) })

    expect(resolve(room, '테', 1)).toBe('char-2')
    expect(resolve(room, '테', 2)).toBe('char-1')
  })

  it('이름이 해소되지 않는 점유자는 후보에서 빠지고 서수 슬롯도 소모하지 않는다', () => {
    const resolve = createRoomPlayerResolver(resolveName)
    const room = makeRoom({ occupants: new Set(['ghost', 'char-1', 'char-2']) })

    expect(resolve(room, '테')).toBe('char-1')
    expect(resolve(room, '테', 2)).toBe('char-2')
    expect(resolve(room, '테', 3)).toBeUndefined()
  })

  it('빈 문자열 이름을 돌려주는 점유자도 후보에서 빠진다', () => {
    const resolve = createRoomPlayerResolver((id) => (id === 'blank' ? '' : names[id]))
    const room = makeRoom({ occupants: new Set(['blank', 'char-1']) })

    expect(resolve(room, '테')).toBe('char-1')
  })

  it('주입된 이름 해소자에만 위임한다(자체 조회 경로 없음)', () => {
    const spy = vi.fn((characterId: string) => names[characterId])
    const resolve = createRoomPlayerResolver(spy)
    const room = makeRoom({ occupants: new Set(['char-1']) })

    expect(resolve(room, '테')).toBe('char-1')
    expect(spy).toHaveBeenCalledWith('char-1')
  })

  it('입력 방·occupants를 변형하지 않는다(순수)', () => {
    const resolve = createRoomPlayerResolver(resolveName)
    const room = makeRoom({ occupants: new Set(['char-1', 'char-2']) })

    resolve(room, '테', 2)

    expect([...room.occupants]).toEqual(['char-1', 'char-2'])
  })
})
