import { describe, it, expect } from 'vitest'
import type { ObjectInstance } from 'shared'
import { F_SET, OCURSE, OALCRT } from '../world/hexFlags.js'
import {
  MAGE,
  CLERIC,
  FIGHTER,
  BARBARIAN,
  ASSASSIN,
  THIEF,
  PALADIN,
  RANGER,
  INVINCIBLE,
} from '../combat/constants.js'
import { SHARP, THRUST, BLUNT, ARMOR, POTION, BODY, NECK1, FINGER1, WIELD, HELD, HEAD } from './taxonomy.js'
import {
  ONOMAG,
  ONOFEM,
  ONOMAL,
  OMARRI,
  OGOODO,
  OEVILO,
  OCLSEL,
  ONEWEV,
  ONSHAT,
  OEVENT,
  OSIZE2,
  MALE,
  FEMALE,
  HUMAN,
  DWARF,
} from './flags.js'
import {
  wearGate,
  readyGate,
  holdGate,
  type WearActor,
  type WearParams,
  type ReadyParams,
  type HoldParams,
} from './wear.js'

// ── 최소 팩토리 — 모든 게이트를 통과하는 baseline. 테스트마다 필드 하나만 뒤집는다. ──
function baseInstance(): ObjectInstance {
  return {
    _id: 'obj-1',
    objnum: 100,
    type: ARMOR,
    owner: { type: 'character', id: 'char-1' },
    slot: null,
    equipped: false,
    value: 10,
    shotscur: 10,
    schemaVersion: 1,
  }
}

function baseActor(): WearActor {
  return { class: FIGHTER, level: 1, gender: MALE, alignment: 0, race: HUMAN, married: false }
}

function baseParams(): WearParams {
  return {
    flags: '',
    type: ARMOR,
    wearflag: BODY,
    armor: 0,
    shotsmax: 10,
    shotscur: 10,
    questnum: 0,
    instance: baseInstance(),
    occupiedSlots: new Set<number>(),
    actor: baseActor(),
  }
}

describe('wearGate', () => {
  // baseline이 clean equip를 반환해야 downstream 단일 게이트 테스트가 오염되지 않는다.
  it('baseline 입력은 equipped를 반환한다', () => {
    const outcome = wearGate(baseParams())
    expect(outcome.kind).toBe('equipped')
    if (outcome.kind === 'equipped') {
      expect(outcome.object.equipped).toBe(true)
      expect(outcome.object.slot).toBe(BODY - 1)
    }
  })

  // ── 0. 라우팅 게이트 ───────────────────────────────────────────────────────
  it('wearflag===0이면 rejected (착용 대상 아님)', () => {
    expect(wearGate({ ...baseParams(), wearflag: 0 }).kind).toBe('rejected')
  })
  it('wearflag===WIELD이면 rejected (무기는 wear 대상 아님)', () => {
    expect(wearGate({ ...baseParams(), wearflag: WIELD }).kind).toBe('rejected')
  })
  it('wearflag===HELD이면 rejected (든 물건은 wear 대상 아님)', () => {
    expect(wearGate({ ...baseParams(), wearflag: HELD }).kind).toBe('rejected')
  })

  // ── ① ONOMAG (type===ARMOR 조건부) ─────────────────────────────────────────
  it('① ONOMAG + MAGE면 rejected', () => {
    const p = { ...baseParams(), flags: F_SET('', ONOMAG), actor: { ...baseActor(), class: MAGE } }
    expect(wearGate(p).kind).toBe('rejected')
  })
  it('① ONOMAG + CLERIC면 rejected', () => {
    const p = { ...baseParams(), flags: F_SET('', ONOMAG), actor: { ...baseActor(), class: CLERIC } }
    expect(wearGate(p).kind).toBe('rejected')
  })
  it('① ONOMAG + FIGHTER면 통과(equipped)', () => {
    const p = { ...baseParams(), flags: F_SET('', ONOMAG), actor: { ...baseActor(), class: FIGHTER } }
    expect(wearGate(p).kind).toBe('equipped')
  })
  it('① ONOMAG는 type!==ARMOR면 무시(POTION+MAGE도 통과 대상)', () => {
    // POTION은 wearflag 라우팅을 통과해야 하므로 wearflag=BODY 유지, type만 POTION으로.
    const p = { ...baseParams(), type: POTION, flags: F_SET('', ONOMAG), actor: { ...baseActor(), class: MAGE } }
    expect(wearGate(p).kind).toBe('equipped')
  })

  // ── ② 성별 (type===ARMOR 조건부) ───────────────────────────────────────────
  it('② ONOFEM + 여성이면 rejected', () => {
    const p = { ...baseParams(), flags: F_SET('', ONOFEM), actor: { ...baseActor(), gender: FEMALE } }
    expect(wearGate(p).kind).toBe('rejected')
  })
  it('② ONOMAL + 남성이면 rejected', () => {
    const p = { ...baseParams(), flags: F_SET('', ONOMAL), actor: { ...baseActor(), gender: MALE } }
    expect(wearGate(p).kind).toBe('rejected')
  })
  it('② ONOFEM + 남성이면 통과', () => {
    const p = { ...baseParams(), flags: F_SET('', ONOFEM), actor: { ...baseActor(), gender: MALE } }
    expect(wearGate(p).kind).toBe('equipped')
  })
  it('② 성별 게이트는 type!==ARMOR면 무시', () => {
    const p = { ...baseParams(), type: POTION, flags: F_SET('', ONOFEM), actor: { ...baseActor(), gender: FEMALE } }
    expect(wearGate(p).kind).toBe('equipped')
  })

  // ── ③ 소각-shots ──────────────────────────────────────────────────────────
  it('③ shotsmax>1001 && questnum===0이면 burned', () => {
    expect(wearGate({ ...baseParams(), shotsmax: 2000 }).kind).toBe('burned')
  })
  it('③ shotscur>1001 && questnum===0이면 burned', () => {
    expect(wearGate({ ...baseParams(), shotscur: 2000 }).kind).toBe('burned')
  })
  it('③ shotsmax>1001이라도 questnum!==0이면 소각 우회 → equipped', () => {
    const p = { ...baseParams(), shotsmax: 2000, questnum: 5 }
    expect(wearGate(p).kind).toBe('equipped')
  })
  it('③ 경계: shotsmax===1001이면 소각 아님(>1001만 소각)', () => {
    expect(wearGate({ ...baseParams(), shotsmax: 1001 }).kind).toBe('equipped')
  })

  // ── ④ 레벨/AC ─────────────────────────────────────────────────────────────
  it('④ check_ac>151 && questnum===0이면 burned (BODY armor*2)', () => {
    // armor 100 → BODY check_ac = 200 > 151
    expect(wearGate({ ...baseParams(), wearflag: BODY, armor: 100 }).kind).toBe('burned')
  })
  it('④ 비BODY는 armor*5 — armor 40 → 200 > 151 burned', () => {
    // HEAD 슬롯: check_ac = 40*5 = 200
    expect(wearGate({ ...baseParams(), wearflag: HEAD, armor: 40 }).kind).toBe('burned')
  })
  it('④ check_ac>151 && questnum!==0이면 소각 우회 → equipped', () => {
    const p = { ...baseParams(), armor: 100, questnum: 5 }
    expect(wearGate(p).kind).toBe('equipped')
  })
  it('④ intra 순서: check_ac>151은 <30 리셋으로 구제되지 않고 burned', () => {
    // armor 100 → 200 > 151 → burned. <30 리셋이 먼저였다면 통과했을 것.
    expect(wearGate({ ...baseParams(), armor: 100 }).kind).toBe('burned')
  })
  it('④ 레벨 부족이면 rejected (30<=check_ac<=151, level<check_ac)', () => {
    // armor 20 BODY → check_ac=40, level 1 < 40 → rejected
    expect(wearGate({ ...baseParams(), armor: 20, actor: { ...baseActor(), level: 1 } }).kind).toBe('rejected')
  })
  it('④ level>=check_ac면 통과', () => {
    const p = { ...baseParams(), armor: 20, actor: { ...baseActor(), level: 50 } }
    expect(wearGate(p).kind).toBe('equipped')
  })
  it('④ check_ac<30이면 0으로 리셋되어 레벨 무관 통과', () => {
    // armor 10 BODY → check_ac=20<30→0 → level 1도 통과
    expect(wearGate({ ...baseParams(), armor: 10, actor: { ...baseActor(), level: 1 } }).kind).toBe('equipped')
  })
})

describe('wearGate — E6 유예 명시 입력 게이트', () => {
  // ── ⑤ 결혼 (type===ARMOR 조건부) ───────────────────────────────────────────
  it('⑤ OMARRI + 미혼이면 rejected', () => {
    const p = { ...baseParams(), flags: F_SET('', OMARRI), actor: { ...baseActor(), married: false } }
    expect(wearGate(p).kind).toBe('rejected')
  })
  it('⑤ OMARRI + 기혼이면 통과', () => {
    const p = { ...baseParams(), flags: F_SET('', OMARRI), actor: { ...baseActor(), married: true } }
    expect(wearGate(p).kind).toBe('equipped')
  })
  it('⑤ 결혼 게이트는 type!==ARMOR면 무시', () => {
    const p = { ...baseParams(), type: POTION, flags: F_SET('', OMARRI), actor: { ...baseActor(), married: false } }
    expect(wearGate(p).kind).toBe('equipped')
  })

  // ── ⑧ 정렬 (전 착용템) ─────────────────────────────────────────────────────
  it('⑧ OGOODO + 정렬<-50이면 bounced', () => {
    const p = { ...baseParams(), flags: F_SET('', OGOODO), actor: { ...baseActor(), alignment: -60 } }
    expect(wearGate(p).kind).toBe('bounced')
  })
  it('⑧ OEVILO + 정렬>50이면 bounced', () => {
    const p = { ...baseParams(), flags: F_SET('', OEVILO), actor: { ...baseActor(), alignment: 60 } }
    expect(wearGate(p).kind).toBe('bounced')
  })
  it('⑧ OGOODO + 정렬>=-50이면 통과', () => {
    const p = { ...baseParams(), flags: F_SET('', OGOODO), actor: { ...baseActor(), alignment: -50 } }
    expect(wearGate(p).kind).toBe('equipped')
  })
})

describe('wearGate — 슬롯 점유(⑥)·파손(⑦)', () => {
  it('⑥ BODY 슬롯 점유면 rejected (만석)', () => {
    const p = { ...baseParams(), wearflag: BODY, occupiedSlots: new Set([BODY - 1]) }
    expect(wearGate(p).kind).toBe('rejected')
  })
  it('⑥ NECK 2칸 모두 점유면 rejected', () => {
    const p = { ...baseParams(), wearflag: NECK1, occupiedSlots: new Set([3, 4]) }
    expect(wearGate(p).kind).toBe('rejected')
  })
  it('⑥ NECK 1칸만 점유면 두 번째 슬롯으로 통과', () => {
    const p = { ...baseParams(), wearflag: NECK1, occupiedSlots: new Set([3]) }
    const outcome = wearGate(p)
    expect(outcome.kind).toBe('equipped')
    if (outcome.kind === 'equipped') expect(outcome.object.slot).toBe(4)
  })
  it('⑥ FINGER 8칸 모두 점유면 rejected', () => {
    const p = { ...baseParams(), wearflag: FINGER1, occupiedSlots: new Set([8, 9, 10, 11, 12, 13, 14, 15]) }
    expect(wearGate(p).kind).toBe('rejected')
  })
  it('⑥ FINGER 일부 점유면 first-free 슬롯으로 통과', () => {
    const p = { ...baseParams(), wearflag: FINGER1, occupiedSlots: new Set([8, 9]) }
    const outcome = wearGate(p)
    expect(outcome.kind).toBe('equipped')
    if (outcome.kind === 'equipped') expect(outcome.object.slot).toBe(10)
  })

  it('⑦ shotscur<1이면 rejected (부서짐)', () => {
    expect(wearGate({ ...baseParams(), shotscur: 0 }).kind).toBe('rejected')
  })

  it('⑦↔⑧ 순서 잠금: 파손 + OGOODO 정렬위반 동시면 ⑦(파손) 먼저 발화 → rejected(bounced 아님)', () => {
    // 오라클 command3.c: ⑦ shotscur<1(line 148) → rejected가 ⑧ 정렬(line 153) → bounced보다 앞선다.
    // 두 게이트의 outcome kind가 달라(rejected≠bounced) 순서 재배열 시 조용히 뒤집힐 수 있으므로 잠근다.
    const p = { ...baseParams(), shotscur: 0, flags: F_SET('', OGOODO), actor: { ...baseActor(), alignment: -60 } }
    expect(wearGate(p).kind).toBe('rejected')
  })
})

describe('wearGate — OCLSEL(⑨)·OSIZE(⑩)·INVINCIBLE 우회', () => {
  // ── ⑨ OCLSEL ──────────────────────────────────────────────────────────────
  it('⑨ OCLSEL + class 비트 없으면 rejected', () => {
    // OCLSEL만 세트, OCLSEL+class 비트 없음 → reject
    const p = { ...baseParams(), flags: F_SET('', OCLSEL), actor: { ...baseActor(), class: FIGHTER } }
    expect(wearGate(p).kind).toBe('rejected')
  })
  it('⑨ OCLSEL + class 비트 있으면 통과', () => {
    const flags = F_SET(F_SET('', OCLSEL), OCLSEL + FIGHTER)
    const p = { ...baseParams(), flags, actor: { ...baseActor(), class: FIGHTER } }
    expect(wearGate(p).kind).toBe('equipped')
  })

  // ── ⑩ OSIZE ───────────────────────────────────────────────────────────────
  it('⑩ OSIZE 소형 제한 + HUMAN이면 rejected (맞지 않음)', () => {
    // OSIZE2만 세트 → i=1(소형) → HUMAN 거부
    const p = { ...baseParams(), flags: F_SET('', OSIZE2), actor: { ...baseActor(), race: HUMAN } }
    expect(wearGate(p).kind).toBe('rejected')
  })
  it('⑩ OSIZE 소형 제한 + DWARF이면 통과', () => {
    const p = { ...baseParams(), flags: F_SET('', OSIZE2), actor: { ...baseActor(), race: DWARF } }
    expect(wearGate(p).kind).toBe('equipped')
  })

  // ── INVINCIBLE 3게이트 우회(레벨④·OCLSEL⑨·OSIZE⑩) ─────────────────────────
  it('INVINCIBLE은 레벨(④) 게이트를 우회', () => {
    // armor 20 → check_ac 40, level 1 <40이지만 class>=INVINCIBLE이라 통과
    const p = { ...baseParams(), armor: 20, actor: { ...baseActor(), class: INVINCIBLE, level: 1 } }
    expect(wearGate(p).kind).toBe('equipped')
  })
  it('INVINCIBLE은 OCLSEL(⑨) 게이트를 우회', () => {
    const p = { ...baseParams(), flags: F_SET('', OCLSEL), actor: { ...baseActor(), class: INVINCIBLE } }
    expect(wearGate(p).kind).toBe('equipped')
  })
  it('INVINCIBLE은 OSIZE(⑩) 게이트를 우회', () => {
    // 소형 제한 아이템을 INVINCIBLE HUMAN이 착용 통과
    const p = { ...baseParams(), flags: F_SET('', OSIZE2), actor: { ...baseActor(), class: INVINCIBLE, race: HUMAN } }
    expect(wearGate(p).kind).toBe('equipped')
  })
})

describe('wearGate — advisor 정밀 검증점', () => {
  // 1. 융합 방지 판별: OGOODO(⑧ bounced) + OCLSEL-mismatch(⑨ rejected) 동시 → ⑧ 먼저 → bounced
  it('융합 방지: OGOODO+정렬<-50 && OCLSEL-mismatch면 bounced (rejected 아님)', () => {
    const flags = F_SET(F_SET('', OGOODO), OCLSEL)
    const p = { ...baseParams(), flags, actor: { ...baseActor(), alignment: -60, class: FIGHTER } }
    expect(wearGate(p).kind).toBe('bounced')
  })

  // 2. ONEWEV 소각 비면제: ONEWEV + check_ac>151 && questnum===0 → 여전히 burned
  it('ONEWEV 비면제: ONEWEV + check_ac>151 && questnum===0면 burned', () => {
    const p = { ...baseParams(), flags: F_SET('', ONEWEV), armor: 100, questnum: 0 }
    expect(wearGate(p).kind).toBe('burned')
  })
  it('ONEWEV은 레벨 거부(④)만 면제: check_ac 30~151에서 level 부족이라도 통과', () => {
    // armor 20 BODY → check_ac 40, level 1 <40, ONEWEV → 통과
    const p = { ...baseParams(), flags: F_SET('', ONEWEV), armor: 20, actor: { ...baseActor(), level: 1 } }
    expect(wearGate(p).kind).toBe('equipped')
  })

  // 4. intra-④ 순서(중복 강조): burned, <30 리셋 미구제
  it('intra-④: check_ac>151 && questnum===0은 burned', () => {
    expect(wearGate({ ...baseParams(), armor: 100, questnum: 0 }).kind).toBe('burned')
  })

  // 저주(OCURSE)는 wear 게이트에 포함되지 않음(오라클 충실 — 저주는 탈착 시점 판정).
  // 이 테스트는 향후 wear.ts에 저주 게이트가 잘못 추가되는 회귀를 잠근다.
  it('저주(OCURSE)는 wear 게이트에 포함되지 않음 — 착용 통과', () => {
    expect(wearGate({ ...baseParams(), flags: F_SET('', OCURSE) }).kind).toBe('equipped')
  })
})

describe('wearGate — immutability (T5.3)', () => {
  it('통과 시 새 ObjectInstance를 반환하고 입력 인스턴스를 변경하지 않는다', () => {
    const instance = baseInstance()
    const p = { ...baseParams(), instance }
    const outcome = wearGate(p)
    expect(outcome.kind).toBe('equipped')
    // 입력 무변경
    expect(instance.equipped).toBe(false)
    expect(instance.slot).toBe(null)
    if (outcome.kind === 'equipped') {
      // 새 객체
      expect(outcome.object).not.toBe(instance)
      expect(outcome.object.equipped).toBe(true)
      expect(outcome.object.slot).toBe(BODY - 1)
    }
  })

  it('resolveSlot 결과(0-based)를 slot에 설정한다', () => {
    const p = { ...baseParams(), wearflag: HEAD, armor: 0 }
    const outcome = wearGate(p)
    expect(outcome.kind).toBe('equipped')
    if (outcome.kind === 'equipped') expect(outcome.object.slot).toBe(HEAD - 1)
  })
})

// ══════════════════════════════════════════════════════════════════════════
// Story 6 — 무기 장착(ready)·쥠(hold) 게이트
// ══════════════════════════════════════════════════════════════════════════

const WIELD_SLOT = WIELD - 1 // 19
const HELD_SLOT = HELD - 1 // 16

// ── readyGate 최소 팩토리 — 모든 게이트를 통과하는 baseline(SHARP 무기, dice 낮음). ──
function baseReadyParams(): ReadyParams {
  return {
    flags: '',
    type: SHARP,
    wearflag: WIELD,
    ndice: 1,
    sdice: 1,
    pdice: 0,
    shotsmax: 10,
    shotscur: 10,
    questnum: 0,
    instance: baseInstance(),
    occupiedSlots: new Set<number>(),
    actor: baseActor(),
    // ⑫가 비대상 테스트를 오염시키지 않도록 소유자 일치를 기본값으로 둔다.
    isBoundOwner: true,
  }
}

describe('readyGate — 오라클 command3.c:691~ 순서', () => {
  it('baseline은 equipped(slot=WIELD_SLOT=19)를 반환한다', () => {
    const outcome = readyGate(baseReadyParams())
    expect(outcome.kind).toBe('equipped')
    if (outcome.kind === 'equipped') {
      expect(outcome.object.equipped).toBe(true)
      expect(outcome.object.slot).toBe(WIELD_SLOT)
    }
  })

  // ── ① WIELD 아님 ───────────────────────────────────────────────────────────
  it('① wearflag!==WIELD(BODY)이면 rejected', () => {
    expect(readyGate({ ...baseReadyParams(), wearflag: BODY }).kind).toBe('rejected')
  })
  it('① wearflag===HELD이면 rejected', () => {
    expect(readyGate({ ...baseReadyParams(), wearflag: HELD }).kind).toBe('rejected')
  })

  // ── ② 마법사 무거운무기(dice합>14, ONOMAG 아님) ────────────────────────────
  it('② SHARP dice합>14 + MAGE면 rejected (ONOMAG 없이도 발화)', () => {
    // ndice5*sdice3+pdice0 = 15 > 14. ONOMAG 플래그 미설정.
    const p = { ...baseReadyParams(), ndice: 5, sdice: 3, pdice: 0, actor: { ...baseActor(), class: MAGE } }
    expect(readyGate(p).kind).toBe('rejected')
  })
  it('② SHARP dice합>14 + CLERIC면 rejected', () => {
    const p = { ...baseReadyParams(), ndice: 5, sdice: 3, pdice: 0, actor: { ...baseActor(), class: CLERIC } }
    expect(readyGate(p).kind).toBe('rejected')
  })
  it('② SHARP dice합>14 + FIGHTER면 ② 미발화 → equipped', () => {
    // dice 15, FIGHTER: ② 미발화(MAGE/CLERIC 아님). ⑪ check_dmg 15-7=8 not>15 → skip → equipped.
    const p = { ...baseReadyParams(), ndice: 5, sdice: 3, pdice: 0, actor: { ...baseActor(), class: FIGHTER } }
    expect(readyGate(p).kind).toBe('equipped')
  })
  it('② dice합===14(경계, >14 아님) + MAGE면 ② 미발화 → equipped', () => {
    // 14는 >14 아님. MAGE check_dmg 14 not >15 → ⑪ 통과 → equipped.
    const p = { ...baseReadyParams(), ndice: 7, sdice: 2, pdice: 0, actor: { ...baseActor(), class: MAGE } }
    expect(readyGate(p).kind).toBe('equipped')
  })
  it('② questnum!==0이면 ② 미발화(dice>14 MAGE라도 통과)', () => {
    const p = { ...baseReadyParams(), ndice: 5, sdice: 3, pdice: 0, questnum: 5, actor: { ...baseActor(), class: MAGE } }
    expect(readyGate(p).kind).toBe('equipped')
  })
  it('② ONEWEV이면 ② 미발화(dice>14 MAGE라도 통과, isBoundOwner true)', () => {
    const p = { ...baseReadyParams(), flags: F_SET('', ONEWEV), ndice: 5, sdice: 3, pdice: 0, actor: { ...baseActor(), class: MAGE }, isBoundOwner: true }
    expect(readyGate(p).kind).toBe('equipped')
  })
  it('② THRUST도 dice합>14 + MAGE면 rejected', () => {
    const p = { ...baseReadyParams(), type: THRUST, ndice: 5, sdice: 3, pdice: 0, actor: { ...baseActor(), class: MAGE } }
    expect(readyGate(p).kind).toBe('rejected')
  })

  // ── ③ 성별 (SHARP/THRUST 조건부) ────────────────────────────────────────────
  it('③ SHARP + ONOFEM + 여성이면 rejected', () => {
    const p = { ...baseReadyParams(), flags: F_SET('', ONOFEM), actor: { ...baseActor(), gender: FEMALE } }
    expect(readyGate(p).kind).toBe('rejected')
  })
  it('③ SHARP + ONOMAL + 남성이면 rejected', () => {
    const p = { ...baseReadyParams(), flags: F_SET('', ONOMAL), actor: { ...baseActor(), gender: MALE } }
    expect(readyGate(p).kind).toBe('rejected')
  })
  it('③ SHARP + ONOFEM + 남성이면 통과', () => {
    const p = { ...baseReadyParams(), flags: F_SET('', ONOFEM), actor: { ...baseActor(), gender: MALE } }
    expect(readyGate(p).kind).toBe('equipped')
  })
  it('③ BLUNT + ONOFEM + 여성이면 성별 게이트 미발화 → equipped (SHARP/THRUST 아님)', () => {
    const p = { ...baseReadyParams(), type: BLUNT, flags: F_SET('', ONOFEM), actor: { ...baseActor(), gender: FEMALE } }
    expect(readyGate(p).kind).toBe('equipped')
  })

  // ── ④ WIELD 슬롯 점유 ──────────────────────────────────────────────────────
  it('④ WIELD 슬롯(19) 점유면 rejected (이미 무장)', () => {
    const p = { ...baseReadyParams(), occupiedSlots: new Set([WIELD_SLOT]) }
    expect(readyGate(p).kind).toBe('rejected')
  })

  // ── ⑤ OCLSEL ───────────────────────────────────────────────────────────────
  it('⑤ OCLSEL + class 비트 없으면 rejected', () => {
    const p = { ...baseReadyParams(), flags: F_SET('', OCLSEL), actor: { ...baseActor(), class: FIGHTER } }
    expect(readyGate(p).kind).toBe('rejected')
  })
  it('⑤ OCLSEL + class 비트 있으면 통과', () => {
    const flags = F_SET(F_SET('', OCLSEL), OCLSEL + FIGHTER)
    const p = { ...baseReadyParams(), flags, actor: { ...baseActor(), class: FIGHTER } }
    expect(readyGate(p).kind).toBe('equipped')
  })

  // ── ⑥ 정렬 → bounced ───────────────────────────────────────────────────────
  it('⑥ OGOODO + 정렬<-50이면 bounced', () => {
    const p = { ...baseReadyParams(), flags: F_SET('', OGOODO), actor: { ...baseActor(), alignment: -60 } }
    expect(readyGate(p).kind).toBe('bounced')
  })
  it('⑥ OEVILO + 정렬>50이면 bounced', () => {
    const p = { ...baseReadyParams(), flags: F_SET('', OEVILO), actor: { ...baseActor(), alignment: 60 } }
    expect(readyGate(p).kind).toBe('bounced')
  })
  it('⑥ OGOODO + 정렬>=-50이면 통과', () => {
    const p = { ...baseReadyParams(), flags: F_SET('', OGOODO), actor: { ...baseActor(), alignment: -50 } }
    expect(readyGate(p).kind).toBe('equipped')
  })

  // ── ⑦ OSIZE ────────────────────────────────────────────────────────────────
  it('⑦ OSIZE 소형 제한 + HUMAN이면 rejected', () => {
    const p = { ...baseReadyParams(), flags: F_SET('', OSIZE2), actor: { ...baseActor(), race: HUMAN } }
    expect(readyGate(p).kind).toBe('rejected')
  })
  it('⑦ OSIZE 소형 제한 + DWARF이면 통과', () => {
    const p = { ...baseReadyParams(), flags: F_SET('', OSIZE2), actor: { ...baseActor(), race: DWARF } }
    expect(readyGate(p).kind).toBe('equipped')
  })

  // ── ⑧ dice-소각 ────────────────────────────────────────────────────────────
  it('⑧ dice합>39(40) + questnum===0 + !ONEWEV이면 burned', () => {
    const p = { ...baseReadyParams(), ndice: 40, sdice: 1, pdice: 0 }
    expect(readyGate(p).kind).toBe('burned')
  })
  it('⑧ 경계: dice합===39는 소각 아님(높은 레벨로 ⑪ 통과 → equipped)', () => {
    const p = { ...baseReadyParams(), ndice: 39, sdice: 1, pdice: 0, actor: { ...baseActor(), level: 300 } }
    expect(readyGate(p).kind).toBe('equipped')
  })
  it('⑧ dice합>39이라도 questnum!==0이면 ⑧ 미발화(⑨/⑪도 우회) → equipped', () => {
    const p = { ...baseReadyParams(), ndice: 40, sdice: 1, pdice: 0, questnum: 5 }
    expect(readyGate(p).kind).toBe('equipped')
  })
  it('⑧ dice합>39이라도 ONEWEV이면 ⑧ 미발화(isBoundOwner true) → equipped', () => {
    const p = { ...baseReadyParams(), flags: F_SET('', ONEWEV), ndice: 40, sdice: 1, pdice: 0, isBoundOwner: true }
    expect(readyGate(p).kind).toBe('equipped')
  })

  // ── ⑨ shots-소각 (비대칭! questnum 무관) ──────────────────────────────────
  it('⑨ shotsmax>600(601) + !ONEWEV이면 burned', () => {
    const p = { ...baseReadyParams(), shotsmax: 601 }
    expect(readyGate(p).kind).toBe('burned')
  })
  it('⑨ shotscur>600(601) + !ONEWEV이면 burned', () => {
    const p = { ...baseReadyParams(), shotscur: 601 }
    expect(readyGate(p).kind).toBe('burned')
  })
  it('⑨ 경계: shotsmax===600은 소각 아님 → equipped', () => {
    const p = { ...baseReadyParams(), shotsmax: 600 }
    expect(readyGate(p).kind).toBe('equipped')
  })
  it('⑨ 비대칭: 임무무기(questnum!==0) + shots>600이면 여전히 burned', () => {
    // questnum이 ⑨를 우회하지 못한다 — ⑧과 다르다.
    const p = { ...baseReadyParams(), shotsmax: 601, questnum: 5 }
    expect(readyGate(p).kind).toBe('burned')
  })
  it('⑨ ONEWEV이면 shots>600 소각 우회 → equipped', () => {
    const p = { ...baseReadyParams(), flags: F_SET('', ONEWEV), shotsmax: 601, isBoundOwner: true }
    expect(readyGate(p).kind).toBe('equipped')
  })

  // ── ⑩ shatter-crit 소각 (플랜 T6.1 요약 초과) ──────────────────────────────
  it('⑩ ONSHAT + OALCRT이면 burned', () => {
    const flags = F_SET(F_SET('', ONSHAT), OALCRT)
    expect(readyGate({ ...baseReadyParams(), flags }).kind).toBe('burned')
  })
  it('⑩ ONSHAT 단독이면 소각 아님 → equipped', () => {
    expect(readyGate({ ...baseReadyParams(), flags: F_SET('', ONSHAT) }).kind).toBe('equipped')
  })
  it('⑩ OALCRT 단독이면 소각 아님 → equipped', () => {
    expect(readyGate({ ...baseReadyParams(), flags: F_SET('', OALCRT) }).kind).toBe('equipped')
  })

  // ── ⑪ 레벨 (check_dmg 직업별 감산) ─────────────────────────────────────────
  it('⑪ dice합22 + FIGHTER(−7=15)면 ⑪ 미발화 → equipped(level 1)', () => {
    // 22-7=15, not >15 → 게이트 skip.
    const p = { ...baseReadyParams(), ndice: 22, sdice: 1, pdice: 0, actor: { ...baseActor(), class: FIGHTER, level: 1 } }
    expect(readyGate(p).kind).toBe('equipped')
  })
  it('⑪ dice합22 + BARBARIAN(감산없음=22>15)면 level 1<66 → rejected', () => {
    const p = { ...baseReadyParams(), ndice: 22, sdice: 1, pdice: 0, actor: { ...baseActor(), class: BARBARIAN, level: 1 } }
    expect(readyGate(p).kind).toBe('rejected')
  })
  it('⑪ dice합22 + ASSASSIN(−3=19>15)면 level 1<57 → rejected', () => {
    const p = { ...baseReadyParams(), ndice: 22, sdice: 1, pdice: 0, actor: { ...baseActor(), class: ASSASSIN, level: 1 } }
    expect(readyGate(p).kind).toBe('rejected')
  })
  it('⑪ dice합22 + THIEF(−3=19>15)면 level 1<57 → rejected', () => {
    const p = { ...baseReadyParams(), ndice: 22, sdice: 1, pdice: 0, actor: { ...baseActor(), class: THIEF, level: 1 } }
    expect(readyGate(p).kind).toBe('rejected')
  })
  it('⑪ dice합22 + PALADIN(−2=20>15)면 level 1<60 → rejected', () => {
    const p = { ...baseReadyParams(), ndice: 22, sdice: 1, pdice: 0, actor: { ...baseActor(), class: PALADIN, level: 1 } }
    expect(readyGate(p).kind).toBe('rejected')
  })
  it('⑪ dice합22 + RANGER(−2=20>15)면 level 1<60 → rejected', () => {
    const p = { ...baseReadyParams(), ndice: 22, sdice: 1, pdice: 0, actor: { ...baseActor(), class: RANGER, level: 1 } }
    expect(readyGate(p).kind).toBe('rejected')
  })
  it('⑪ level>=check_dmg*3이면 통과(BARBARIAN dice22 level66)', () => {
    // check_dmg 22*3=66, level 66 not <66 → 통과.
    const p = { ...baseReadyParams(), ndice: 22, sdice: 1, pdice: 0, actor: { ...baseActor(), class: BARBARIAN, level: 66 } }
    expect(readyGate(p).kind).toBe('equipped')
  })
  it('⑪ questnum!==0이면 ⑪ 미발화 → equipped', () => {
    const p = { ...baseReadyParams(), ndice: 22, sdice: 1, pdice: 0, questnum: 5, actor: { ...baseActor(), class: BARBARIAN, level: 1 } }
    expect(readyGate(p).kind).toBe('equipped')
  })
  it('⑪ ONEWEV이면 ⑪ 미발화(isBoundOwner true) → equipped', () => {
    const p = { ...baseReadyParams(), flags: F_SET('', ONEWEV), ndice: 22, sdice: 1, pdice: 0, actor: { ...baseActor(), class: BARBARIAN, level: 1 }, isBoundOwner: true }
    expect(readyGate(p).kind).toBe('equipped')
  })

  // ── ⑫ ONEWEV 귀속 ──────────────────────────────────────────────────────────
  it('⑫ ONEWEV + isBoundOwner=false면 rejected (다른 사람의 물건)', () => {
    const p = { ...baseReadyParams(), flags: F_SET('', ONEWEV), isBoundOwner: false }
    expect(readyGate(p).kind).toBe('rejected')
  })
  it('⑫ ONEWEV + isBoundOwner=true면 통과', () => {
    const p = { ...baseReadyParams(), flags: F_SET('', ONEWEV), isBoundOwner: true }
    expect(readyGate(p).kind).toBe('equipped')
  })
})

describe('readyGate — advisor 정밀 검증점', () => {
  // 순서 잠금: OGOODO 정렬위반(⑥ bounced) + dice>39(⑧ burned) 동시 → ⑥ 먼저 → bounced
  it('순서 잠금: OGOODO+정렬<-50 && dice>39면 bounced (burned 아님)', () => {
    const p = { ...baseReadyParams(), flags: F_SET('', OGOODO), ndice: 40, sdice: 1, pdice: 0, actor: { ...baseActor(), class: FIGHTER, alignment: -60 } }
    expect(readyGate(p).kind).toBe('bounced')
  })

  // 순서 잠금: ⑤ OCLSEL → ⑥ 정렬 순서. wear.ts는 정렬(⑧)→OCLSEL(⑨)로 역순이므로,
  // readyGate를 wear.ts에 맞춰 재배열하면 reject↔bounce가 조용히 뒤집힌다. ⑤가 먼저 발화해 rejected여야 한다.
  it('순서 잠금: OCLSEL-mismatch(⑤) && OGOODO+정렬<-50(⑥) → rejected (⑤ 먼저 — wear.ts와 역순)', () => {
    const flags = F_SET(F_SET('', OCLSEL), OGOODO)
    const p = { ...baseReadyParams(), flags, actor: { ...baseActor(), class: FIGHTER, alignment: -60 } }
    expect(readyGate(p).kind).toBe('rejected')
  })

  // INVINCIBLE 우회: ⑤ OCLSEL·⑦ OSIZE·⑪ 레벨
  it('INVINCIBLE은 OCLSEL(⑤) 게이트를 우회', () => {
    const p = { ...baseReadyParams(), flags: F_SET('', OCLSEL), actor: { ...baseActor(), class: INVINCIBLE } }
    expect(readyGate(p).kind).toBe('equipped')
  })
  it('INVINCIBLE은 OSIZE(⑦) 게이트를 우회', () => {
    const p = { ...baseReadyParams(), flags: F_SET('', OSIZE2), actor: { ...baseActor(), class: INVINCIBLE, race: HUMAN } }
    expect(readyGate(p).kind).toBe('equipped')
  })
  it('INVINCIBLE은 레벨(⑪) 게이트를 우회', () => {
    // dice22 INVINCIBLE(감산없음) level 1 <66이지만 class>=INVINCIBLE이라 통과.
    const p = { ...baseReadyParams(), ndice: 22, sdice: 1, pdice: 0, actor: { ...baseActor(), class: INVINCIBLE, level: 1 } }
    expect(readyGate(p).kind).toBe('equipped')
  })

  // 저주(OCURSE)는 ready 게이트에 포함되지 않음(오라클 충실).
  it('저주(OCURSE)는 ready 게이트에 포함되지 않음 → 통과', () => {
    expect(readyGate({ ...baseReadyParams(), flags: F_SET('', OCURSE) }).kind).toBe('equipped')
  })
})

describe('readyGate — immutability', () => {
  it('통과 시 새 ObjectInstance를 반환하고 입력 인스턴스를 변경하지 않는다', () => {
    const instance = baseInstance()
    const p = { ...baseReadyParams(), instance }
    const outcome = readyGate(p)
    expect(outcome.kind).toBe('equipped')
    expect(instance.equipped).toBe(false)
    expect(instance.slot).toBe(null)
    if (outcome.kind === 'equipped') {
      expect(outcome.object).not.toBe(instance)
      expect(outcome.object.equipped).toBe(true)
      expect(outcome.object.slot).toBe(WIELD_SLOT)
    }
  })
})

// ── holdGate 최소 팩토리 ─────────────────────────────────────────────────────
function baseHoldParams(): HoldParams {
  return {
    flags: '',
    type: SHARP,
    wearflag: HELD,
    ndice: 1,
    sdice: 1,
    pdice: 0,
    questnum: 0,
    instance: baseInstance(),
    occupiedSlots: new Set<number>(),
    actor: baseActor(),
  }
}

describe('holdGate — 오라클 command3.c:860~ 순서', () => {
  it('baseline은 equipped(slot=HELD_SLOT=16)를 반환한다', () => {
    const outcome = holdGate(baseHoldParams())
    expect(outcome.kind).toBe('equipped')
    if (outcome.kind === 'equipped') {
      expect(outcome.object.equipped).toBe(true)
      expect(outcome.object.slot).toBe(HELD_SLOT)
    }
  })

  // ── ① HELD/WIELD 아님 ─────────────────────────────────────────────────────
  it('① wearflag!==HELD && !==WIELD(BODY)이면 rejected', () => {
    expect(holdGate({ ...baseHoldParams(), wearflag: BODY }).kind).toBe('rejected')
  })
  it('① wearflag===WIELD이면 통과(HELD 슬롯 설정)', () => {
    const outcome = holdGate({ ...baseHoldParams(), wearflag: WIELD })
    expect(outcome.kind).toBe('equipped')
    if (outcome.kind === 'equipped') expect(outcome.object.slot).toBe(HELD_SLOT)
  })

  // ── ② 이벤트템/임무템 ──────────────────────────────────────────────────────
  it('② OEVENT이면 rejected', () => {
    expect(holdGate({ ...baseHoldParams(), flags: F_SET('', OEVENT) }).kind).toBe('rejected')
  })
  it('② questnum>0이면 rejected', () => {
    expect(holdGate({ ...baseHoldParams(), questnum: 5 }).kind).toBe('rejected')
  })

  // ── ③ 귀속템 ───────────────────────────────────────────────────────────────
  it('③ ONEWEV이면 rejected', () => {
    expect(holdGate({ ...baseHoldParams(), flags: F_SET('', ONEWEV) }).kind).toBe('rejected')
  })

  // ── ④ HELD 슬롯 점유 ───────────────────────────────────────────────────────
  it('④ HELD 슬롯(16) 점유면 rejected (이미 쥐고)', () => {
    const p = { ...baseHoldParams(), occupiedSlots: new Set([HELD_SLOT]) }
    expect(holdGate(p).kind).toBe('rejected')
  })

  // ── ⑤ 강력무기(dice합>100) ─────────────────────────────────────────────────
  it('⑤ dice합>100(101)이면 rejected', () => {
    const p = { ...baseHoldParams(), ndice: 101, sdice: 1, pdice: 0 }
    expect(holdGate(p).kind).toBe('rejected')
  })
  it('⑤ 경계: dice합===100은 통과', () => {
    const p = { ...baseHoldParams(), ndice: 100, sdice: 1, pdice: 0 }
    expect(holdGate(p).kind).toBe('equipped')
  })

  // ── ⑥ OCLSEL (플랜 T6.2 요약 초과) ─────────────────────────────────────────
  it('⑥ OCLSEL + class 비트 없으면 rejected', () => {
    const p = { ...baseHoldParams(), flags: F_SET('', OCLSEL), actor: { ...baseActor(), class: FIGHTER } }
    expect(holdGate(p).kind).toBe('rejected')
  })
  it('⑥ OCLSEL + class 비트 있으면 통과', () => {
    const flags = F_SET(F_SET('', OCLSEL), OCLSEL + FIGHTER)
    const p = { ...baseHoldParams(), flags, actor: { ...baseActor(), class: FIGHTER } }
    expect(holdGate(p).kind).toBe('equipped')
  })
  it('⑥ INVINCIBLE은 OCLSEL 게이트를 우회', () => {
    const p = { ...baseHoldParams(), flags: F_SET('', OCLSEL), actor: { ...baseActor(), class: INVINCIBLE } }
    expect(holdGate(p).kind).toBe('equipped')
  })

  // ── ⑦ 정렬 → bounced (플랜 T6.2 요약 초과) ─────────────────────────────────
  it('⑦ OGOODO + 정렬<-50이면 bounced', () => {
    const p = { ...baseHoldParams(), flags: F_SET('', OGOODO), actor: { ...baseActor(), alignment: -60 } }
    expect(holdGate(p).kind).toBe('bounced')
  })
  it('⑦ OEVILO + 정렬>50이면 bounced', () => {
    const p = { ...baseHoldParams(), flags: F_SET('', OEVILO), actor: { ...baseActor(), alignment: 60 } }
    expect(holdGate(p).kind).toBe('bounced')
  })

  // ── 무조건 equipped: type>=ARMOR(비무기)도 통과 시 HELD 슬롯 설정 ───────────
  it('type===ARMOR(비무기)도 통과 시 equipped+HELD 슬롯(16) 설정', () => {
    const outcome = holdGate({ ...baseHoldParams(), type: ARMOR })
    expect(outcome.kind).toBe('equipped')
    if (outcome.kind === 'equipped') {
      expect(outcome.object.equipped).toBe(true)
      expect(outcome.object.slot).toBe(HELD_SLOT)
    }
  })
})

describe('holdGate — immutability', () => {
  it('통과 시 새 ObjectInstance를 반환하고 입력 인스턴스를 변경하지 않는다', () => {
    const instance = baseInstance()
    const p = { ...baseHoldParams(), instance }
    const outcome = holdGate(p)
    expect(outcome.kind).toBe('equipped')
    expect(instance.equipped).toBe(false)
    expect(instance.slot).toBe(null)
    if (outcome.kind === 'equipped') {
      expect(outcome.object).not.toBe(instance)
      expect(outcome.object.slot).toBe(HELD_SLOT)
    }
  })
})
