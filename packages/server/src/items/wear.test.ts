import { describe, it, expect } from 'vitest'
import type { ObjectInstance } from 'shared'
import { F_SET, OCURSE } from '../world/hexFlags.js'
import { MAGE, CLERIC, FIGHTER, INVINCIBLE } from '../combat/constants.js'
import { ARMOR, POTION, BODY, NECK1, FINGER1, WIELD, HELD, HEAD } from './taxonomy.js'
import { ONOMAG, ONOFEM, ONOMAL, OMARRI, OGOODO, OEVILO, OCLSEL, ONEWEV, OSIZE2, MALE, FEMALE, HUMAN, DWARF } from './flags.js'
import { wearGate, type WearActor, type WearParams } from './wear.js'

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
