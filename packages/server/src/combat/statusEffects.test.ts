import { describe, it, expect } from 'vitest'
import { type Character } from 'shared'
import {
  grantPoison,
  grantDisease,
  grantBlind,
  grantSilence,
  grantFear,
  clearPoison,
  clearDisease,
  clearBlind,
  clearSilence,
  clearFear,
  isPoisonActive,
  isDiseaseActive,
  isBlindActive,
  isSilenceActive,
  isFearActive,
  projectStatusFlags,
} from './statusEffects.js'
import { F_ISSET, PPOISN, PDISEA, PBLIND, PSILNC, PFEARS } from '../world/hexFlags.js'

/**
 * statusEffects — 명명 상태이상(Story 1 characterSchema.statusEffects)의 부여·만료 순수 헬퍼와
 * 명명 필드 → combat flag hex 뷰 투영.
 *
 * 만료 관례: until은 절대-틱(잔여-틱 아님). `until < now`이면 비활성, `until >= now`이면 활성.
 * 투영: Character에는 flags 필드가 없으므로(flags는 PlayerCombatState 소관) 병합 대상이 없다 —
 * ZERO_FLAGS에서 활성 비트만 F_SET한 fresh hex를 반환한다.
 */
function makeCharacter(overrides: Partial<Character> = {}): Character {
  return {
    _id: 'char-1',
    name: '테스토스',
    class: 4,
    race: 1,
    stats: [16, 18, 12, 10, 14],
    gold: 100,
    currentRoom: 1,
    hpCurrent: 42,
    mpCurrent: 15,
    level: 7,
    experience: 0,
    // v5 spell store 시드(빈 지식 비트마스크·realm [0,0,0,0]) — Character required 필드 충족.
    spells: new Array<number>(16).fill(0),
    realm: [0, 0, 0, 0],
    schemaVersion: 2,
    accountId: 'acct-1',
    status: 'active',
    alignment: 1,
    ...overrides,
  }
}

describe('grant* 부여 헬퍼', () => {
  it('grantPoison은 poison until/interval을 세팅한 새 Character를 반환한다', () => {
    const before = makeCharacter()
    const after = grantPoison(before, 120, 6)
    expect(after.statusEffects?.poison).toEqual({ until: 120, interval: 6 })
  })

  it('grantDisease는 disease until/interval을 세팅한다', () => {
    const after = grantDisease(makeCharacter(), 200, 12)
    expect(after.statusEffects?.disease).toEqual({ until: 200, interval: 12 })
  })

  it('grantBlind는 blind until만 세팅한다(간격 없음)', () => {
    const after = grantBlind(makeCharacter(), 50)
    expect(after.statusEffects?.blind).toEqual({ until: 50 })
  })

  it('기존 statusEffects의 다른 효과를 보존하며 병합한다', () => {
    const withPoison = grantPoison(makeCharacter(), 120, 6)
    const withBoth = grantBlind(withPoison, 50)
    expect(withBoth.statusEffects?.poison).toEqual({ until: 120, interval: 6 })
    expect(withBoth.statusEffects?.blind).toEqual({ until: 50 })
  })

  it('입력 Character를 변형하지 않는다(불변)', () => {
    const before = makeCharacter()
    grantPoison(before, 120, 6)
    expect(before.statusEffects).toBeUndefined()
  })

  it('기존 statusEffects 객체를 변형하지 않는다(불변)', () => {
    const withPoison = grantPoison(makeCharacter(), 120, 6)
    const snapshot = { ...withPoison.statusEffects }
    grantBlind(withPoison, 50)
    expect(withPoison.statusEffects).toEqual(snapshot)
  })
})

describe('is*Active 만료 판정', () => {
  it('until >= now이면 활성', () => {
    const c = grantPoison(makeCharacter(), 100, 6)
    expect(isPoisonActive(c, 50)).toBe(true)
  })

  it('until === now는 활성(경계값)', () => {
    const c = grantPoison(makeCharacter(), 100, 6)
    expect(isPoisonActive(c, 100)).toBe(true)
  })

  it('until < now이면 비활성', () => {
    const c = grantPoison(makeCharacter(), 100, 6)
    expect(isPoisonActive(c, 101)).toBe(false)
  })

  it('효과가 없으면 비활성', () => {
    expect(isPoisonActive(makeCharacter(), 0)).toBe(false)
    expect(isDiseaseActive(makeCharacter(), 0)).toBe(false)
    expect(isBlindActive(makeCharacter(), 0)).toBe(false)
  })

  it('disease/blind도 동일한 만료 관례를 따른다', () => {
    const c = grantBlind(grantDisease(makeCharacter(), 100, 12), 100)
    expect(isDiseaseActive(c, 100)).toBe(true)
    expect(isDiseaseActive(c, 101)).toBe(false)
    expect(isBlindActive(c, 100)).toBe(true)
    expect(isBlindActive(c, 101)).toBe(false)
  })
})

describe('projectStatusFlags 투영', () => {
  it('활성 poison → F_ISSET(hex, PPOISN)===true', () => {
    const c = grantPoison(makeCharacter(), 100, 6)
    const hex = projectStatusFlags(c, 50)
    expect(F_ISSET(hex, PPOISN)).toBe(true)
  })

  it('활성 disease → F_ISSET(hex, PDISEA)===true', () => {
    const c = grantDisease(makeCharacter(), 100, 12)
    const hex = projectStatusFlags(c, 50)
    expect(F_ISSET(hex, PDISEA)).toBe(true)
  })

  it('활성 blind → F_ISSET(hex, PBLIND)===true (combat 관용 판독 가능)', () => {
    const c = grantBlind(makeCharacter(), 100)
    const hex = projectStatusFlags(c, 50)
    expect(F_ISSET(hex, PBLIND)).toBe(true)
  })

  it('여러 활성 효과가 동시에 투영된다', () => {
    const c = grantBlind(grantDisease(grantPoison(makeCharacter(), 100, 6), 100, 12), 100)
    const hex = projectStatusFlags(c, 50)
    expect(F_ISSET(hex, PPOISN)).toBe(true)
    expect(F_ISSET(hex, PDISEA)).toBe(true)
    expect(F_ISSET(hex, PBLIND)).toBe(true)
  })

  it('만료(until < now) 효과는 투영에서 제외된다', () => {
    const c = grantPoison(makeCharacter(), 100, 6)
    const hex = projectStatusFlags(c, 101)
    expect(F_ISSET(hex, PPOISN)).toBe(false)
  })

  it('한 효과는 만료, 다른 효과는 활성 → 활성 비트만 세팅된다', () => {
    // poison until 100 (만료: now 150), blind until 200 (활성)
    const c = grantBlind(grantPoison(makeCharacter(), 100, 6), 200)
    const hex = projectStatusFlags(c, 150)
    expect(F_ISSET(hex, PPOISN)).toBe(false)
    expect(F_ISSET(hex, PBLIND)).toBe(true)
  })

  it('statusEffects가 없으면 all-clear hex(모든 비트 false)', () => {
    const hex = projectStatusFlags(makeCharacter(), 0)
    expect(F_ISSET(hex, PPOISN)).toBe(false)
    expect(F_ISSET(hex, PDISEA)).toBe(false)
    expect(F_ISSET(hex, PBLIND)).toBe(false)
  })
})

describe('clear* 해제 헬퍼 (Story 10 cure 소비)', () => {
  it('clearPoison은 poison만 해제하고 disease/blind는 보존한다', () => {
    const before = grantBlind(grantDisease(grantPoison(makeCharacter(), 100, 6), 200, 12), 300)
    const after = clearPoison(before)
    expect(after.statusEffects).toEqual({ disease: { until: 200, interval: 12 }, blind: { until: 300 } })
  })

  it('clearDisease는 disease만 해제한다', () => {
    const before = grantDisease(grantPoison(makeCharacter(), 100, 6), 200, 12)
    const after = clearDisease(before)
    expect(after.statusEffects).toEqual({ poison: { until: 100, interval: 6 } })
  })

  it('clearBlind는 blind만 해제한다', () => {
    const before = grantBlind(makeCharacter(), 300)
    const after = clearBlind(before)
    expect(after.statusEffects).toEqual({})
  })

  it('clear는 입력 Character·statusEffects를 변형하지 않는다(immutability)', () => {
    const before = grantPoison(makeCharacter(), 100, 6)
    clearPoison(before)
    expect(before.statusEffects?.poison).toEqual({ until: 100, interval: 6 })
  })

  it('statusEffects가 없으면 clearPoison/clearDisease/clearBlind 모두 입력을 그대로 반환한다(throw 없음)', () => {
    const before = makeCharacter()
    expect(clearPoison(before)).toBe(before)
    expect(clearDisease(before)).toBe(before)
    expect(clearBlind(before)).toBe(before)
  })
})

/**
 * 침묵·공포 헬퍼 — blind 대칭(간격 없음, until만). 시전 경로는 미배선이므로 이 헬퍼들은
 * 순수 함수 계약만 검증한다(debuffEffects의 플레이어 대상 유예 무변경).
 */
describe('grantSilence/grantFear 부여 헬퍼', () => {
  it('grantSilence는 silence until만 세팅한다(간격 없음)', () => {
    const after = grantSilence(makeCharacter(), 100)
    expect(after.statusEffects?.silence).toEqual({ until: 100 })
  })

  it('grantFear는 fear until만 세팅한다(간격 없음)', () => {
    const after = grantFear(makeCharacter(), 80)
    expect(after.statusEffects?.fear).toEqual({ until: 80 })
  })

  it('기존 statusEffects의 다른 효과를 보존하며 병합한다', () => {
    const merged = grantFear(grantSilence(grantPoison(makeCharacter(), 120, 6), 100), 80)
    expect(merged.statusEffects?.poison).toEqual({ until: 120, interval: 6 })
    expect(merged.statusEffects?.silence).toEqual({ until: 100 })
    expect(merged.statusEffects?.fear).toEqual({ until: 80 })
  })

  it('입력 Character를 변형하지 않는다(불변)', () => {
    const before = makeCharacter()
    grantSilence(before, 100)
    grantFear(before, 80)
    expect(before.statusEffects).toBeUndefined()
  })

  it('기존 statusEffects 객체를 변형하지 않는다(불변)', () => {
    const withPoison = grantPoison(makeCharacter(), 120, 6)
    const snapshot = { ...withPoison.statusEffects }
    grantSilence(withPoison, 100)
    grantFear(withPoison, 80)
    expect(withPoison.statusEffects).toEqual(snapshot)
  })
})

describe('isSilenceActive/isFearActive 만료 판정', () => {
  it('until > now이면 활성', () => {
    const c = grantFear(grantSilence(makeCharacter(), 100), 100)
    expect(isSilenceActive(c, 50)).toBe(true)
    expect(isFearActive(c, 50)).toBe(true)
  })

  it('until === now는 활성(경계값)', () => {
    const c = grantFear(grantSilence(makeCharacter(), 100), 100)
    expect(isSilenceActive(c, 100)).toBe(true)
    expect(isFearActive(c, 100)).toBe(true)
  })

  it('until < now이면 비활성', () => {
    const c = grantFear(grantSilence(makeCharacter(), 100), 100)
    expect(isSilenceActive(c, 101)).toBe(false)
    expect(isFearActive(c, 101)).toBe(false)
  })

  it('효과가 없으면 비활성', () => {
    expect(isSilenceActive(makeCharacter(), 0)).toBe(false)
    expect(isFearActive(makeCharacter(), 0)).toBe(false)
  })
})

describe('clearSilence/clearFear 해제 헬퍼', () => {
  it('clearSilence는 silence만 해제하고 다른 효과를 보존한다', () => {
    const before = grantFear(grantSilence(grantBlind(makeCharacter(), 300), 100), 80)
    const after = clearSilence(before)
    expect(after.statusEffects).toEqual({ blind: { until: 300 }, fear: { until: 80 } })
  })

  it('clearFear는 fear만 해제하고 다른 효과를 보존한다', () => {
    const before = grantFear(grantSilence(grantBlind(makeCharacter(), 300), 100), 80)
    const after = clearFear(before)
    expect(after.statusEffects).toEqual({ blind: { until: 300 }, silence: { until: 100 } })
  })

  it('입력 Character·statusEffects를 변형하지 않는다(immutability)', () => {
    const before = grantFear(grantSilence(makeCharacter(), 100), 80)
    const snapshot = { ...before.statusEffects }
    clearSilence(before)
    clearFear(before)
    expect(before.statusEffects).toEqual(snapshot)
  })

  it('statusEffects가 없으면 clearSilence/clearFear 모두 입력을 그대로 반환한다(throw 없음)', () => {
    const before = makeCharacter()
    expect(clearSilence(before)).toBe(before)
    expect(clearFear(before)).toBe(before)
  })
})

// 비트 번호(PSILNC 44·PFEARS 43) 자체의 고정은 소유 모듈 테스트(world/hexFlags.test.ts)가 맡는다 —
// help/pflags 문서 값이 raw #define보다 +1인 off-by-one 함정이라 정본 모듈에서 pin한다.
describe('projectStatusFlags — PSILNC·PFEARS 투영', () => {
  it('활성 silence → F_ISSET(hex, PSILNC)===true (비트 44)', () => {
    const hex = projectStatusFlags(grantSilence(makeCharacter(), 100), 50)
    expect(F_ISSET(hex, PSILNC)).toBe(true)
  })

  it('활성 fear → F_ISSET(hex, PFEARS)===true (비트 43)', () => {
    const hex = projectStatusFlags(grantFear(makeCharacter(), 100), 50)
    expect(F_ISSET(hex, PFEARS)).toBe(true)
  })

  it('만료(until < now)된 silence·fear는 투영에서 제외된다', () => {
    const c = grantFear(grantSilence(makeCharacter(), 100), 100)
    const hex = projectStatusFlags(c, 101)
    expect(F_ISSET(hex, PSILNC)).toBe(false)
    expect(F_ISSET(hex, PFEARS)).toBe(false)
  })

  it('silence는 활성·fear는 만료 → silence 비트만 세팅된다', () => {
    const c = grantFear(grantSilence(makeCharacter(), 200), 100)
    const hex = projectStatusFlags(c, 150)
    expect(F_ISSET(hex, PSILNC)).toBe(true)
    expect(F_ISSET(hex, PFEARS)).toBe(false)
  })

  it('5종 동시 활성 시 PPOISN·PDISEA·PBLIND·PFEARS·PSILNC가 모두 세팅되고 폭은 16자다', () => {
    const c = grantFear(
      grantSilence(
        grantBlind(grantDisease(grantPoison(makeCharacter(), 100, 6), 100, 12), 100),
        100,
      ),
      100,
    )
    const hex = projectStatusFlags(c, 50)
    expect(F_ISSET(hex, PPOISN)).toBe(true)
    expect(F_ISSET(hex, PDISEA)).toBe(true)
    expect(F_ISSET(hex, PBLIND)).toBe(true)
    expect(F_ISSET(hex, PFEARS)).toBe(true)
    expect(F_ISSET(hex, PSILNC)).toBe(true)
    expect(hex).toHaveLength(16)
  })

  it('statusEffects가 없으면 silence·fear 비트도 clear이고 폭은 16자다(ZERO_FLAGS 불변)', () => {
    const hex = projectStatusFlags(makeCharacter(), 0)
    expect(F_ISSET(hex, PSILNC)).toBe(false)
    expect(F_ISSET(hex, PFEARS)).toBe(false)
    expect(hex).toBe('0000000000000000')
  })
})
