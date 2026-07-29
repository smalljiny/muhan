import { describe, it, expect, vi } from 'vitest'
import { characterSchema, type Character } from 'shared'
import { createMarkCharacterDirty, type RawMarkDirty } from './markCharacterDirty.js'

/**
 * markCharacterDirty — characters 컬렉션 markDirty의 단일 계약 지점.
 *
 * 두 가지를 고정한다: (a) 스냅샷이 라이브 객체와 **별칭을 공유하지 않는다**(mark 이후 라이브 변이가
 * 기록된 스냅샷에 새지 않는다), (b) 인자가 전체 `Character`가 아니면 **컴파일 단계에서 거부**된다.
 * (a)가 깨지면 DirtyTracker LWW 계약이 무너지고, (b)가 깨지면 부분 스냅샷이 flush돼 write-loss가 난다.
 */
function makeCharacter(overrides: Partial<Character> = {}): Character {
  return {
    _id: 'char-1',
    name: '테스토스',
    class: 4,
    race: 1,
    stats: [16, 18, 12, 10, 14],
    gold: 100,
    currentRoom: 7,
    hpCurrent: 42,
    mpCurrent: 15,
    level: 7,
    experience: 1234,
    spells: new Array<number>(16).fill(0),
    realm: [0, 0, 0, 0],
    schemaVersion: 5,
    accountId: 'acct-1',
    status: 'active',
    ...overrides,
  }
}

/** 원시 markDirty seam을 spy로 두고 헬퍼를 감싼 하네스. */
function harness() {
  const markDirty = vi.fn<RawMarkDirty>()
  const markCharacterDirty = createMarkCharacterDirty(markDirty)
  const snapshot = (): Character => markDirty.mock.calls[0]?.[2] as Character
  return { markDirty, markCharacterDirty, snapshot }
}

describe('createMarkCharacterDirty', () => {
  describe('markDirty 위임 형태', () => {
    it("collection은 'characters' 리터럴, id는 그대로 전달하고 1회만 호출한다", () => {
      const h = harness()

      h.markCharacterDirty('char-9', makeCharacter({ _id: 'char-9' }))

      expect(h.markDirty).toHaveBeenCalledTimes(1)
      expect(h.markDirty).toHaveBeenCalledWith('characters', 'char-9', expect.anything())
    })

    it('top-level 스칼라(_id·level·gold·currentRoom)를 스냅샷에 그대로 싣는다', () => {
      const h = harness()
      const character = makeCharacter({ _id: 'char-1', level: 7, gold: 100, currentRoom: 7 })

      h.markCharacterDirty('char-1', character)

      expect(h.snapshot()).toMatchObject({ _id: 'char-1', level: 7, gold: 100, currentRoom: 7 })
    })
  })

  describe('별칭 차단 — mark 이후 라이브 변이가 스냅샷에 새지 않는다', () => {
    it('stats·spells·realm 원소를 변이해도 스냅샷은 불변이다(배열 1단 복사)', () => {
      const h = harness()
      const character = makeCharacter()

      h.markCharacterDirty('char-1', character)
      const snap = h.snapshot()
      character.stats[0] = 99
      character.spells[0] = 255
      character.realm[0] = 5_000

      expect(snap.stats[0]).toBe(16)
      expect(snap.spells[0]).toBe(0)
      expect(snap.realm[0]).toBe(0)
      // 컨테이너 자체도 별개 참조여야 한다(원소 변이 차단의 전제).
      expect(snap.stats).not.toBe(character.stats)
      expect(snap.spells).not.toBe(character.spells)
      expect(snap.realm).not.toBe(character.realm)
    })

    it("buffs['5'].until을 변이해도 스냅샷은 불변이다(엔트리 객체 단위 복사)", () => {
      const h = harness()
      const character = makeCharacter({ buffs: { 5: { until: 100 } } })

      h.markCharacterDirty('char-1', character)
      const snap = h.snapshot()
      const liveBuff = character.buffs?.[5]
      if (liveBuff === undefined) throw new Error('픽스처 불변식: buffs[5]가 있어야 한다')
      liveBuff.until = 999

      expect(snap.buffs?.[5]?.until).toBe(100)
    })

    it('statusEffects.poison.until을 변이해도 스냅샷은 불변이다(엔트리 객체 단위 복사)', () => {
      const h = harness()
      const character = makeCharacter({
        statusEffects: {
          poison: { until: 200, interval: 10 },
          disease: { until: 300, interval: 20 },
          blind: { until: 400 },
        },
      })

      h.markCharacterDirty('char-1', character)
      const snap = h.snapshot()
      const livePoison = character.statusEffects?.poison
      if (livePoison === undefined) throw new Error('픽스처 불변식: poison이 있어야 한다')
      livePoison.until = 999

      expect(snap.statusEffects?.poison?.until).toBe(200)
      // 나머지 두 효과도 값 보존 + 별개 참조.
      expect(snap.statusEffects?.disease).toEqual({ until: 300, interval: 20 })
      expect(snap.statusEffects?.blind).toEqual({ until: 400 })
      expect(snap.statusEffects?.disease).not.toBe(character.statusEffects?.disease)
    })
  })

  describe('optional 키 형태 보존', () => {
    it('buffs·statusEffects 미보유 캐릭터의 스냅샷에는 두 키가 존재하지 않는다', () => {
      const h = harness()

      h.markCharacterDirty('char-1', makeCharacter())
      const snap = h.snapshot()

      // `{buffs: undefined}` 주입은 $set 문서 형태를 바꾸므로 키 자체가 없어야 한다.
      expect('buffs' in snap).toBe(false)
      expect('statusEffects' in snap).toBe(false)
    })

    it('엔트리 값이 undefined면 그 엔트리 키를 스냅샷에 만들지 않는다', () => {
      const h = harness()
      const character = makeCharacter({
        buffs: { 5: { until: 100 }, 7: undefined },
        statusEffects: { poison: { until: 200, interval: 10 } },
      })

      h.markCharacterDirty('char-1', character)
      const snap = h.snapshot()

      expect(snap.buffs).toEqual({ 5: { until: 100 } })
      expect(snap.statusEffects).toEqual({ poison: { until: 200, interval: 10 } })
    })

    it('deletedAt은 같은 Date 참조를 유지한다(soft-delete 필드 — 라이브 in-place 변이 없음)', () => {
      const h = harness()
      const deletedAt = new Date('2026-07-29T00:00:00.000Z')
      const character = makeCharacter({ status: 'deleted', deletedAt })

      h.markCharacterDirty('char-1', character)

      expect(h.snapshot().deletedAt).toBe(deletedAt)
    })
  })

  describe('타입 경계 — 부분 스냅샷 차단', () => {
    it('부분 스냅샷 리터럴은 컴파일 단계에서 거부된다', () => {
      const h = harness()
      // 타입 경계만 고정한다 — 실행하면 Character 필수 필드가 없어 런타임에서 깨지므로 호출하지 않는다.
      // 검증 주체는 `@ts-expect-error`다: 이 줄이 실제로 타입 에러가 아니면 tsc가 unused directive로
      // 실패하므로, 런타임 단언 없이도 계약이 강제된다.
      const _rejectedByCompiler = (): void => {
        // @ts-expect-error 부분 스냅샷은 Character가 아니므로 markCharacterDirty에 도달할 수 없다.
        h.markCharacterDirty('char-1', { currentRoom: 3 })
      }
    })
  })

  describe('status 제외 — 라이브가 소유하지 않는 필드', () => {
    it("status:'active' 라이브 캐릭터의 스냅샷에 status 키가 존재하지 않는다", () => {
      const h = harness()

      h.markCharacterDirty('char-1', makeCharacter({ status: 'active' }))

      // status를 실으면 형제 세션의 soft-delete(status='deleted')를 라이브 flush가 되돌린다(무덤 부활).
      expect('status' in h.snapshot()).toBe(false)
    })

    it("status:'deleted' 라이브 객체라도 스냅샷은 status를 싣지 않는다", () => {
      const h = harness()

      h.markCharacterDirty('char-1', makeCharacter({ status: 'deleted' }))

      expect('status' in h.snapshot()).toBe(false)
    })
  })

  describe('스키마 드리프트 가드', () => {
    it('characterSchema 키 인벤토리가 스냅샷 복사 목록과 동기화돼 있다', () => {
      // snapshotCharacter는 얕은 spread + stats/spells/realm/buffs/statusEffects 명시 복사다.
      // 스키마에 필드가 추가되면 이 단언이 실패한다 — 새 필드가 배열·객체 같은 **가변 컨테이너**면
      // snapshotCharacter의 복사 목록에 추가하고(별칭 잔존 방지), 스칼라면 이 기대 목록만 갱신하라.
      const EXPECTED_KEYS = [
        '_id',
        'accountId',
        'alignment',
        'buffs',
        'class',
        'currentRoom',
        'deletedAt',
        'experience',
        'gender',
        'gold',
        'hpCurrent',
        'level',
        'mpCurrent',
        'name',
        'race',
        'realm',
        'schemaVersion',
        'spells',
        'stats',
        'status',
        'statusEffects',
        'weapon',
      ]

      expect(
        Object.keys(characterSchema.shape).sort(),
        '새 필드가 가변 컨테이너면 snapshotCharacter의 복사 목록에 추가하라',
      ).toEqual(EXPECTED_KEYS)
    })
  })
})
