import { describe, it, expect } from 'vitest'
import {
  characterSchema,
  computeAc,
  computeThaco,
  type Character,
  type EffectiveStatContext,
  type ObjectInstance,
} from 'shared'
import { assemblePlayerCombatState } from './assemblePlayerCombatState.js'
import {
  makeObjectInstance,
  makeObjectTemplate,
  makeTemplateIndex,
} from '../items/objectFixtures.testutil.js'
import { flagsHex, NO_FLAGS } from '../world/roomFixtures.testutil.js'
import { PPROTE, PBLESS, F_ISSET } from '../world/hexFlags.js'
import { HELD, WIELD_SLOT } from '../items/taxonomy.js'
import type { LiveCharacter } from '../world/liveCharacterRegistry.js'

/**
 * LiveCharacter → PlayerCombatState 조립기 테스트.
 *
 * 이 조립기는 산술을 소유하지 않는다 — armor/thaco는 toPlayerCombatState 경유의 stats-core
 * 결과와 정확히 같아야 하고, 장비 기여는 projectEquipStats 결과와 같아야 한다. 그래서 기대값을
 * 손으로 적은 숫자가 아니라 같은 입력으로 호출한 stats-core 결과로 표현한다.
 */

/** 능력치 튜플 순서: strength0·dexterity1·constitution2·intelligence3·piety4. */
const STRENGTH = 16
const DEXTERITY = 18

/**
 * 시드 캐릭터 — `characterSchema.parse`를 통과시켜 만든다. 리터럴을 그대로 쓰면 스키마가 거부할
 * 시드로도 테스트가 통과해 배선 검출력이 떨어진다(`ws/reconnectRevert.testutil.ts` 관례).
 */
function makeCharacter(overrides: Partial<Character> = {}): Character {
  return characterSchema.parse({
    _id: 'char-1',
    name: '테스토스',
    class: 4,
    race: 1,
    stats: [STRENGTH, DEXTERITY, 12, 10, 14],
    gold: 100,
    currentRoom: 1,
    hpCurrent: 42,
    mpCurrent: 15,
    level: 7,
    experience: 0,
    spells: new Array<number>(16).fill(0),
    realm: [0, 0, 0, 0],
    schemaVersion: 6,
    accountId: 'acct-1',
    status: 'active',
    alignment: 1,
    ...overrides,
  })
}

function makeLive(
  inventory: readonly ObjectInstance[],
  character = makeCharacter(),
): LiveCharacter {
  return { character, inventory }
}

/** 기대 EffectiveStatContext — 조립기가 만들어야 할 컨텍스트를 테스트가 독립적으로 재현한다. */
function expectedContext(overrides: Partial<EffectiveStatContext> = {}): EffectiveStatContext {
  return {
    effectiveStrength: STRENGTH,
    effectiveDexterity: DEXTERITY,
    equipArmor: 0,
    protection: false,
    characterClass: 4,
    level: 7,
    weaponAdjustment: 0,
    weaponProficiency: 0,
    ...overrides,
  }
}

/** 무기 템플릿(objnum 200) — WIELD 슬롯 착용 시 weapon으로 해소돼야 한다. */
const WEAPON_FLAGS = flagsHex(3)
const weaponTemplate = makeObjectTemplate({
  objnum: 200,
  name: '장검',
  type: 0,
  ndice: 2,
  sdice: 6,
  pdice: 3,
  adjustment: 4,
  armor: 1,
  flags: WEAPON_FLAGS,
})

/**
 * 두 번째 무기 템플릿(objnum 201) — 첫 무기와 adjustment가 뚜렷이 달라, 명중 보정과 피해 서술자가
 * 서로 다른 무기를 가리키면 단언이 반드시 깨진다.
 */
const secondWeaponTemplate = makeObjectTemplate({
  objnum: 201,
  name: '단검',
  type: 0,
  ndice: 1,
  sdice: 4,
  pdice: 0,
  adjustment: 50,
  armor: 0,
})

/** 방어구 템플릿(objnum 300) — equipArmor에만 기여한다. */
const armorTemplate = makeObjectTemplate({ objnum: 300, name: '갑옷', armor: 5 })

const templates = makeTemplateIndex([weaponTemplate, secondWeaponTemplate, armorTemplate])

function wieldedWeapon(overrides: Partial<ObjectInstance> = {}): ObjectInstance {
  return makeObjectInstance({
    _id: 'obj-weapon',
    objnum: 200,
    type: 0,
    slot: WIELD_SLOT,
    equipped: true,
    ...overrides,
  })
}

function wornArmor(overrides: Partial<ObjectInstance> = {}): ObjectInstance {
  return makeObjectInstance({
    _id: 'obj-armor',
    objnum: 300,
    slot: 0,
    equipped: true,
    ...overrides,
  })
}

describe('assemblePlayerCombatState', () => {
  describe('무기 해소', () => {
    it('WIELD 착용이면 weapon 6필드가 템플릿 값(+proficiency 0)과 일치한다', () => {
      const state = assemblePlayerCombatState(makeLive([wieldedWeapon()]), templates, NO_FLAGS)
      expect(state.weapon).toEqual({
        ndice: 2,
        sdice: 6,
        pdice: 3,
        adjustment: 4,
        proficiency: 0,
        flags: WEAPON_FLAGS,
      })
    })

    // weapon이 null로 떨어지는 갈래를 표로 묶는다 — 케이스를 더할 때 블록을 복사하지 않게 하고,
    // 무기가 스탯에도 기여하면 안 되는 갈래(스탯 열이 true인 행)를 비대칭이 아니라 열로 드러낸다.
    it.each([
      ['WIELD 미착용(방어구만)', () => [wornArmor()], false],
      ['빈 인벤', () => [], false],
      ['WIELD가 아닌 슬롯(HELD)에 착용', () => [wieldedWeapon({ slot: HELD - 1 })], false],
      ['템플릿이 인덱스에 없음', () => [wieldedWeapon({ objnum: 999 })], true],
      ['equipped=false인 WIELD 슬롯', () => [wieldedWeapon({ equipped: false })], true],
    ])('%s이면 weapon이 null이다(맨손 분기)', (_label, makeInventory, assertNoStatContribution) => {
      const state = assemblePlayerCombatState(makeLive(makeInventory()), templates, NO_FLAGS)
      expect(state.weapon).toBeNull()
      if (assertNoStatContribution) {
        // 무기 인스턴스가 인벤에 있으나 집계되지 않아야 하는 갈래 — armor(무기 armor 미반영)와
        // thaco(weaponAdjustment=0)가 무기 없는 컨텍스트 결과와 같아야 한다.
        expect(state.armor).toBe(computeAc(expectedContext()))
        expect(state.thaco).toBe(computeThaco(expectedContext()))
      }
    })

    // weaponAdjustment(명중)와 weapon(피해)이 **같은 아이템**에서 와야 한다. 두 산출물이 서로 다른
    // 모듈에서 만들어지므로, 후보가 여럿일 때 선택이 갈리면 명중은 A 무기로 피해는 B 무기로 계산된다.
    // 두 모듈 각자는 자기 안에서 일관되므로 이 케이스가 없으면 갈라짐이 드러나지 않는다.
    it('WIELD 착용 후보가 둘이면 명중 보정과 피해 서술자가 같은 무기(입력 순서 첫 매치)에서 온다', () => {
      // 단검(adjustment 50)을 앞에, 장검(adjustment 4)을 뒤에 둔다. 두 산출물이 갈리면
      // weapon은 한쪽을, thaco는 다른 쪽 adjustment를 반영해 아래 두 단언 중 하나가 깨진다.
      const dagger = wieldedWeapon({ _id: 'obj-dagger', objnum: 201 })
      const sword = wieldedWeapon({ _id: 'obj-sword', objnum: 200 })
      const state = assemblePlayerCombatState(makeLive([dagger, sword]), templates, NO_FLAGS)

      expect(state.weapon?.adjustment).toBe(50)
      expect(state.thaco).toBe(computeThaco(expectedContext({ weaponAdjustment: 50 })))
    })
  })

  describe('EffectiveStatContext 조립', () => {
    it('effectiveStrength·dexterity를 stats 튜플(0·1)에서 취한다', () => {
      const state = assemblePlayerCombatState(makeLive([]), templates, NO_FLAGS)
      expect(state.effectiveStrength).toBe(STRENGTH)
      expect(state.dexterity).toBe(DEXTERITY)
    })

    it('armor를 착용 장비 armor 합이 반영된 computeAc 결과로 파생한다', () => {
      const live = makeLive([wieldedWeapon(), wornArmor()])
      const state = assemblePlayerCombatState(live, templates, NO_FLAGS)
      expect(state.armor).toBe(computeAc(expectedContext({ equipArmor: 6 })))
    })

    it('thaco를 WIELD 무기 adjustment가 반영된 computeThaco 결과로 파생한다', () => {
      const live = makeLive([wieldedWeapon(), wornArmor()])
      const state = assemblePlayerCombatState(live, templates, NO_FLAGS)
      expect(state.thaco).toBe(
        computeThaco(expectedContext({ equipArmor: 6, weaponAdjustment: 4 })),
      )
    })

    it('protection이 F_ISSET(flags, PPROTE)와 일치한다(세팅 시 AC가 protection=true 결과)', () => {
      const flags = flagsHex(PPROTE)
      expect(F_ISSET(flags, PPROTE)).toBe(true)
      const state = assemblePlayerCombatState(makeLive([]), templates, flags)
      expect(state.armor).toBe(computeAc(expectedContext({ protection: true })))
    })

    it('PPROTE가 없는 flags면 protection=false 결과를 쓴다', () => {
      const flags = flagsHex(PBLESS)
      expect(F_ISSET(flags, PPROTE)).toBe(false)
      const state = assemblePlayerCombatState(makeLive([]), templates, flags)
      expect(state.armor).toBe(computeAc(expectedContext({ protection: false })))
    })

    it('class·level을 캐릭터에서 취한다', () => {
      const character = makeCharacter({ class: 2, level: 11 })
      const state = assemblePlayerCombatState(makeLive([], character), templates, NO_FLAGS)
      expect(state.class).toBe(2)
      expect(state.level).toBe(11)
      expect(state.thaco).toBe(computeThaco(expectedContext({ characterClass: 2, level: 11 })))
    })

    it('주입 flags를 그대로 싣는다', () => {
      const flags = flagsHex(PPROTE)
      const state = assemblePlayerCombatState(makeLive([]), templates, flags)
      expect(state.flags).toBe(flags)
    })
  })

  describe('carry override', () => {
    it('carry 미지정이면 캐릭터 HP/MP와 nextAttackAt 0을 쓴다', () => {
      const state = assemblePlayerCombatState(makeLive([]), templates, NO_FLAGS)
      expect(state.hpCurrent).toBe(42)
      expect(state.mpCurrent).toBe(15)
      expect(state.nextAttackAt).toBe(0)
    })

    it('carry를 주면 hpCurrent·mpCurrent·nextAttackAt 3개만 덮어쓴다', () => {
      const live = makeLive([wieldedWeapon(), wornArmor()])
      const baseline = assemblePlayerCombatState(live, templates, NO_FLAGS)
      const state = assemblePlayerCombatState(live, templates, NO_FLAGS, {
        hpCurrent: 7,
        mpCurrent: 3,
        nextAttackAt: 1234,
      })

      expect(state.hpCurrent).toBe(7)
      expect(state.mpCurrent).toBe(3)
      expect(state.nextAttackAt).toBe(1234)

      // 나머지는 재조립 값을 유지한다.
      expect(state.level).toBe(baseline.level)
      expect(state.armor).toBe(baseline.armor)
      expect(state.thaco).toBe(baseline.thaco)
      expect(state.weapon).toEqual(baseline.weapon)
      expect(state.characterId).toBe(baseline.characterId)
      expect(state.alignment).toBe(baseline.alignment)
    })

    it('입력을 변형하지 않는다 — live·inventory·carry가 조립 전후로 같다', () => {
      const carry = { hpCurrent: 7, mpCurrent: 3, nextAttackAt: 1234 }
      const live = makeLive([wieldedWeapon(), wornArmor()])
      // 조립 전 깊은 사본 — 조립기가 인벤 배열이나 그 원소를 건드리면 아래 대조가 깨진다.
      const liveBefore = structuredClone(live)
      const carryBefore = structuredClone(carry)

      assemblePlayerCombatState(live, templates, NO_FLAGS, carry)

      expect(live).toEqual(liveBefore)
      expect(carry).toEqual(carryBefore)
    })
  })
})
