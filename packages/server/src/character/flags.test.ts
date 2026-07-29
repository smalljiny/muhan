import { describe, it, expect } from 'vitest'
import { SPELL_NO, SPELL_CATALOG, type Character } from 'shared'
import { composeCharacterFlags } from './flags.js'
import { F_ISSET, PHIDDN, PDMINV, PWIMPY, PCHAOS, PFAMIL, PUPDMG } from '../world/hexFlags.js'
import {
  grantPoison,
  grantDisease,
  grantBlind,
  grantFear,
  grantSilence,
  projectStatusFlags,
} from '../combat/statusEffects.js'
import { projectResistFlags, projectBuffFlags } from '../magic/buffEffects.js'
import { grantBuff } from '../magic/spellDuration.js'

/**
 * flags 합성 테스트 — 세 투영(status·resist·buff)의 OR 결과와 **비트 소유권 파티션**을 고정한다.
 *
 * anti-drift 원칙: 기대 비트 집합도, 활성화할 주문 목록도 프로덕션 자료구조(TIMED_BUFF_META·
 * RESIST_FLAG_BY_SPELL·TIMED_BUFF_SPELLS·RESIST_SPELLS)에서 파생하지 않고 리터럴로 적는다. 파생하면
 * 소유권이 옮겨가도 테스트가 함께 움직여 파티션 위반이 조용히 통과한다(예: TIMED_BUFF_META에
 * SFEARS를 추가하면 bit 43이 이중 출처가 되지만 파생 테스트는 그대로 통과). 리터럴로 고정하면
 * buff-단독 케이스가 bit 43을 얻어 즉시 실패한다.
 */

const ZERO16 = '0000000000000000'
const NOW = 1000
const UNTIL = NOW + 100

/** status 투영 소유 비트 — PPOISN(16)·PDISEA(41)·PBLIND(42)·PFEARS(43)·PSILNC(44). */
const STATUS_BITS = [16, 41, 42, 43, 44]
/** resist 투영 소유 비트 — PRFIRE(30)·PRMAGI(32)·PRCOLD(36)·PSSHLD(38). */
const RESIST_BITS = [30, 32, 36, 38]
/** buff 투영 소유 비트 — PBLESS(0)·PINVIS(2)·PPROTE(8)·PLIGHT(17)·PDMAGI(20)·PDINVI(21)·PLEVIT(25)·PFLYSP(31)·PKNOWA(33)·PBRWAT(37). */
const BUFF_BITS = [0, 2, 8, 17, 20, 21, 25, 31, 33, 37]
/** 미소유(범위 밖) 비트 — PHIDDN(1)·PDMINV(10)·PWIMPY(14)·PCHAOS(28)·PFAMIL(55)·PUPDMG(59). */
const UNOWNED_BITS = [PHIDDN, PDMINV, PWIMPY, PCHAOS, PFAMIL, PUPDMG]

/** resist 4주문(리터럴 열거 — RESIST_SPELLS 파생 금지). */
const RESIST_SPELL_NOS = [SPELL_NO.SRFIRE, SPELL_NO.SRMAGI, SPELL_NO.SRCOLD, SPELL_NO.SSSHLD]
/** 타이머 보유 10주문(리터럴 열거 — TIMED_BUFF_SPELLS 파생 금지). */
const BUFF_SPELL_NOS = [
  SPELL_NO.SBLESS,
  SPELL_NO.SPROTE,
  SPELL_NO.SBRWAT,
  SPELL_NO.SDINVI,
  SPELL_NO.SDMAGI,
  SPELL_NO.SKNOWA,
  SPELL_NO.SFLYSP,
  SPELL_NO.SINVIS,
  SPELL_NO.SLEVIT,
  SPELL_NO.SLIGHT,
]

function makeCharacter(over: Partial<Character> = {}): Character {
  return {
    _id: 'c-1',
    name: '테스토스',
    class: 1,
    race: 1,
    stats: [10, 10, 10, 10, 10],
    gold: 0,
    currentRoom: 1,
    hpCurrent: 20,
    mpCurrent: 20,
    level: 10,
    experience: 0,
    spells: new Array<number>(16).fill(0),
    realm: [0, 0, 0, 0],
    schemaVersion: 5,
    accountId: 'a-1',
    status: 'active',
    alignment: 1,
    ...over,
  }
}

/** hex에서 세팅된 비트 인덱스를 오름차순으로 뽑는다(8바이트=64비트 전수 조회). */
function setBits(hex: string): number[] {
  const bits: number[] = []
  for (let bit = 0; bit < 64; bit++) {
    if (F_ISSET(hex, bit)) bits.push(bit)
  }
  return bits
}

/** 명명 상태이상 5종을 전부 활성화한 Character. */
function withAllStatus(base: Character): Character {
  let c = grantPoison(base, UNTIL, 10)
  c = grantDisease(c, UNTIL, 10)
  c = grantBlind(c, UNTIL)
  c = grantFear(c, UNTIL)
  c = grantSilence(c, UNTIL)
  return c
}

/** 지정 주문번호들의 버프를 전부 활성화한 Character(dur 산술 비의존 — until 직접 지정). */
function withBuffs(base: Character, spellNos: readonly number[]): Character {
  return spellNos.reduce((c, spellNo) => grantBuff(c, spellNo, UNTIL), base)
}

/** 세 출처를 전부 활성화한 Character — 활성화 집합의 단일 출처(케이스별 재조립 금지). */
function makeAllActive(): Character {
  return withBuffs(withAllStatus(makeCharacter()), [...RESIST_SPELL_NOS, ...BUFF_SPELL_NOS])
}

describe('composeCharacterFlags — 세 투영 OR 합성', () => {
  it('무효과 캐릭터는 16자 0을 반환한다', () => {
    const hex = composeCharacterFlags(makeCharacter(), NOW)
    expect(hex).toBe(ZERO16)
    expect(hex).toHaveLength(16)
  })

  it('반환 폭은 항상 16자다(효과 유무 무관)', () => {
    expect(composeCharacterFlags(makeAllActive(), NOW)).toHaveLength(16)
  })

  it('만료된 효과는 합성에 반영되지 않는다', () => {
    // until = NOW+100 < now → 전부 만료.
    expect(composeCharacterFlags(makeAllActive(), UNTIL + 1)).toBe(ZERO16)
  })
})

describe('composeCharacterFlags — 비트 소유권 파티션', () => {
  it('status 단독 활성: 세팅 비트가 status 소유 비트와 정확히 일치', () => {
    const hex = composeCharacterFlags(withAllStatus(makeCharacter()), NOW)
    expect(setBits(hex)).toEqual(STATUS_BITS)
  })

  it('resist 단독 활성: 세팅 비트가 resist 소유 비트와 정확히 일치', () => {
    const hex = composeCharacterFlags(withBuffs(makeCharacter(), RESIST_SPELL_NOS), NOW)
    expect(setBits(hex)).toEqual(RESIST_BITS)
  })

  it('buff 단독 활성: 세팅 비트가 buff 소유 비트와 정확히 일치(PFEARS 43·PSILNC 44 미포함)', () => {
    const hex = composeCharacterFlags(withBuffs(makeCharacter(), BUFF_SPELL_NOS), NOW)
    expect(setBits(hex)).toEqual(BUFF_BITS)
  })

  /**
   * 제약 #1 회귀 — PFEARS(43)·PSILNC(44)의 생산자는 projectStatusFlags 단독이다.
   *
   * BUFF_BITS 정확일치만으로는 `TIMED_BUFF_META`에 SFEARS/SSILNC가 **추가**되는 드리프트를 잡지 못한다
   * (버프 단독 캐릭터는 그 주문의 buffs 엔트리가 없어 투영이 false로 빠진다 — 등재해도 통과). 그래서
   * 금지 주문의 buffs 엔트리를 **직접 활성화**한 뒤 아무 비트도 서지 않음을 고정한다: 등재되는 순간
   * bit 43/44가 buff 경로에서도 생산돼 이 케이스가 즉시 실패한다.
   */
  it('공포·침묵 비트는 statusEffects 경로에서만 생산된다(TIMED_BUFF_META 등재 금지)', () => {
    // 같은 의미(공포·침묵)를 buffs로 표현하면 0, statusEffects로 표현해야 43·44가 선다.
    const viaBuffs = composeCharacterFlags(
      withBuffs(makeCharacter(), [SPELL_NO.SFEARS, SPELL_NO.SSILNC]),
      NOW,
    )
    const viaStatus = composeCharacterFlags(
      grantSilence(grantFear(makeCharacter(), UNTIL), UNTIL),
      NOW,
    )
    expect(setBits(viaBuffs)).toEqual([])
    expect(setBits(viaStatus)).toEqual([43, 44])
  })

  it('세 출처 동시 활성: union이 정확히 나온다', () => {
    const expected = [...STATUS_BITS, ...RESIST_BITS, ...BUFF_BITS].sort((a, b) => a - b)
    expect(setBits(composeCharacterFlags(makeAllActive(), NOW))).toEqual(expected)
  })

  it('세 소유 비트 집합은 서로소다(파티션 전제)', () => {
    const all = [...STATUS_BITS, ...RESIST_BITS, ...BUFF_BITS]
    expect(new Set(all).size).toBe(all.length)
  })

  /**
   * 이중 생산 가드 — 합성 결과 한 개만 보면 OR 멱등성이 이중 출처를 가린다(두 투영이 같은 비트를
   * 생산해도 OR 결과가 같아 setBits가 변하지 않는다). 세 투영의 출력을 **분리 관찰**해야 보인다.
   * 카탈로그 전 주문의 버프 + 상태이상 5종을 동시에 켜 미열거 주문 등재까지 사정권에 넣는다.
   */
  it('카탈로그 전 주문 활성 시에도 세 투영의 생산 비트는 쌍마다 서로소다', () => {
    const saturated = withBuffs(
      withAllStatus(makeCharacter()),
      SPELL_CATALOG.map((entry) => entry.spellNo),
    )
    const status = new Set(setBits(projectStatusFlags(saturated, NOW)))
    const resist = new Set(setBits(projectResistFlags(saturated, NOW)))
    const buff = new Set(setBits(projectBuffFlags(saturated, NOW)))
    // 세 집합이 비면 서로소 단언이 공허해진다 — 실제 소유 비트 수를 먼저 고정한다.
    expect([status.size, resist.size, buff.size]).toEqual([
      STATUS_BITS.length,
      RESIST_BITS.length,
      BUFF_BITS.length,
    ])
    const pairs: ReadonlyArray<readonly [string, Set<number>, Set<number>]> = [
      ['status∩resist', status, resist],
      ['status∩buff', status, buff],
      ['resist∩buff', resist, buff],
    ]
    for (const [label, a, b] of pairs) {
      expect([label, [...a].filter((bit) => b.has(bit))]).toEqual([label, []])
    }
  })
})

// 단독 활성 3케이스는 위 파티션 describe가 이미 *정확일치*로 단언하므로 미소유 비트 미세팅을
// 함의한다. 여기서는 최대 활성(세 출처 동시) 한 케이스만 명시적으로 고정한다.
describe('composeCharacterFlags — 미소유 비트는 어떤 입력에서도 미세팅', () => {
  it('전체 활성: PHIDDN·PDMINV·PWIMPY·PCHAOS·PFAMIL·PUPDMG 미세팅', () => {
    const hex = composeCharacterFlags(makeAllActive(), NOW)
    for (const bit of UNOWNED_BITS) {
      expect(F_ISSET(hex, bit)).toBe(false)
    }
  })
})

describe('composeCharacterFlags — 순수 함수(캐시 없음)', () => {
  it('입력 Character를 변형하지 않는다', () => {
    const character = withBuffs(withAllStatus(makeCharacter()), RESIST_SPELL_NOS)
    const snapshot = JSON.parse(JSON.stringify(character)) as unknown
    composeCharacterFlags(character, NOW)
    expect(JSON.parse(JSON.stringify(character))).toEqual(snapshot)
  })

  it('같은 캐릭터라도 now가 바뀌면 결과가 재산출된다(character-only 캐시 부재)', () => {
    const character = withAllStatus(makeCharacter())
    expect(composeCharacterFlags(character, NOW)).not.toBe(ZERO16)
    expect(composeCharacterFlags(character, UNTIL + 1)).toBe(ZERO16)
  })
})
