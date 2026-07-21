import { describe, it, expect } from 'vitest'
import * as catalogModule from './catalog.js'
import {
  SPELL_CATALOG,
  OSPELL_GRID,
  REALM,
  SPELL_NO,
  spellByNo,
  ospellOf,
  type SpellEntry,
  type SpellFamily,
} from './catalog.js'

// catalog 엔트리의 유일 허용 키 — offensive 유예(#85) 경계 검증에 쓴다.
// 함수 참조(effect 본체)가 엔트리에 새어들면 이 집합이 깨진다.
const ALLOWED_ENTRY_KEYS = ['spellNo', 'koreanName', 'family', 'spllv', 'offensive'] as const

// SpellFamily union의 전체 멤버 — 엔트리 family가 이 집합 밖 값을 쓰지 못하게 가둔다.
const VALID_FAMILIES: readonly SpellFamily[] = [
  'healing',
  'cure',
  'buff',
  'resistBuff',
  'detect',
  'movement',
  'debuff',
  'antiUndead',
  'utility',
  'offensive',
]

describe('SPELL_CATALOG — spllist 전사', () => {
  // global.c:575-631의 활성 엔트리는 spellNo 0-55 = 56행이다(SCURSE=56·SNAHAN 제외).
  // 태스크 문구의 "55"는 최대 인덱스(SCHARM=55)를 개수로 오독한 off-by-one이라, byte 정본을 따른다.
  it('활성 주문 56개를 export한다', () => {
    expect(SPELL_CATALOG).toHaveLength(56)
  })

  it('각 엔트리는 정확히 5개 필드만 가진다(effect 함수 참조 없음, #85 유예 경계)', () => {
    for (const entry of SPELL_CATALOG) {
      expect(Object.keys(entry).sort()).toEqual([...ALLOWED_ENTRY_KEYS].sort())
      // 어떤 필드도 함수여선 안 된다 — 비-offensive 36은 메타데이터만 둔다.
      for (const value of Object.values(entry)) {
        expect(typeof value).not.toBe('function')
      }
    }
  })

  it('각 엔트리 필드 타입이 계약을 만족한다', () => {
    for (const entry of SPELL_CATALOG) {
      expect(Number.isInteger(entry.spellNo)).toBe(true)
      expect(entry.koreanName.length).toBeGreaterThan(0)
      expect(VALID_FAMILIES).toContain(entry.family)
      expect(Number.isInteger(entry.spllv)).toBe(true)
      expect(typeof entry.offensive).toBe('boolean')
    }
  })

  it('spellNo가 0-55 전 범위를 유일하게 덮는다', () => {
    const nos = SPELL_CATALOG.map((e) => e.spellNo).sort((a, b) => a - b)
    expect(nos).toEqual(Array.from({ length: 56 }, (_, i) => i))
  })

  it('앵커 엔트리 3종이 byte 정본과 일치한다', () => {
    const byNo = (no: number): SpellEntry => {
      const found = SPELL_CATALOG.find((e) => e.spellNo === no)
      if (!found) throw new Error(`spellNo ${no} 없음`)
      return found
    }
    expect(byNo(0)).toEqual({
      spellNo: 0,
      koreanName: '회복',
      family: 'healing',
      spllv: 1,
      offensive: false,
    })
    expect(byNo(1)).toEqual({
      spellNo: 1,
      koreanName: '삭풍',
      family: 'offensive',
      spllv: 2,
      offensive: true,
    })
    expect(byNo(55)).toEqual({
      spellNo: 55,
      koreanName: '이혼대법',
      family: 'debuff',
      spllv: 5,
      offensive: false,
    })
  })
})

describe('SPELL_CATALOG — offensive/비-offensive 분할', () => {
  it('offensive 엔트리는 정확히 20개, 비-offensive는 36개다', () => {
    const offensive = SPELL_CATALOG.filter((e) => e.offensive)
    const passive = SPELL_CATALOG.filter((e) => !e.offensive)
    expect(offensive).toHaveLength(20)
    expect(passive).toHaveLength(36)
  })

  it('offensive === true 인 엔트리는 모두 family=offensive 다', () => {
    for (const entry of SPELL_CATALOG) {
      if (entry.offensive) expect(entry.family).toBe('offensive')
    }
  })

  it('offensive spellNo 집합이 ospell 격자 spellNo 집합과 정확히 일치한다', () => {
    // 카탈로그의 offensive 플래그와 ospell 격자가 같은 20개를 가리켜야 격자 커버리지가 카탈로그에 묶인다.
    const offensiveNos = new Set(SPELL_CATALOG.filter((e) => e.offensive).map((e) => e.spellNo))
    const gridNos = new Set(OSPELL_GRID.map((e) => e.spellNo))
    expect(offensiveNos).toEqual(gridNos)
  })
})

describe('OSPELL_GRID — realm×tier 격자', () => {
  it('20개 엔트리이며 realm 1-4 × tier 1-5 격자를 유일하게 덮는다', () => {
    expect(OSPELL_GRID).toHaveLength(20)
    // tier는 엔트리에 저장하지 않으므로 mp로 역산한다(격자 tier 파라미터의 mp가 유일 판별자다).
    const mpToTier: Record<number, number> = { 3: 1, 7: 2, 10: 3, 15: 4, 25: 5 }
    const cells = new Set(
      OSPELL_GRID.map((e) => {
        const tier = mpToTier[e.mp]
        return `${e.realm}:${tier}`
      }),
    )
    const expected = new Set<string>()
    for (const realm of [1, 2, 3, 4]) {
      for (const tier of [1, 2, 3, 4, 5]) expected.add(`${realm}:${tier}`)
    }
    expect(cells).toEqual(expected)
  })

  it('격자 기본 셀이 byte 정본과 일치한다', () => {
    // WIND tier1(삭풍) — 기본 셀, 예외 없음.
    expect(ospellOf(SPELL_NO.SHURTS)).toEqual({
      spellNo: 1,
      realm: REALM.WIND,
      mp: 3,
      ndice: 1,
      sdice: 8,
      pdice: 0,
      bonusType: 1,
    })
  })

  it('예외 셀이 byte 정본과 일치한다', () => {
    // FIRE tier1(화선도) — sdice 8→7, pdice 0→1.
    expect(ospellOf(SPELL_NO.SBURNS)).toEqual({
      spellNo: 27,
      realm: REALM.FIRE,
      mp: 3,
      ndice: 1,
      sdice: 7,
      pdice: 1,
      bonusType: 1,
    })
    // FIRE tier2(화궁) — pdice 7→8.
    expect(ospellOf(SPELL_NO.SFIREB)).toEqual({
      spellNo: 6,
      realm: REALM.FIRE,
      mp: 7,
      ndice: 2,
      sdice: 5,
      pdice: 8,
      bonusType: 2,
    })
    // WATER tier2(파초식) — pdice 7→8.
    expect(ospellOf(SPELL_NO.SWBOLT)).toEqual({
      spellNo: 30,
      realm: REALM.WATER,
      mp: 7,
      ndice: 2,
      sdice: 5,
      pdice: 8,
      bonusType: 2,
    })
    // EARTH tier4(토합술) — pdice 18→19.
    expect(ospellOf(SPELL_NO.SSHATT)).toEqual({
      spellNo: 35,
      realm: REALM.EARTH,
      mp: 15,
      ndice: 3,
      sdice: 4,
      pdice: 19,
      bonusType: 3,
    })
  })

  it('격자에 없는 spellNo 조회는 undefined다', () => {
    expect(ospellOf(SPELL_NO.SVIGOR)).toBeUndefined()
  })
})

describe('spellByNo 조회', () => {
  it('존재하는 spellNo의 엔트리를 반환한다', () => {
    expect(spellByNo(0)?.koreanName).toBe('회복')
    expect(spellByNo(55)?.koreanName).toBe('이혼대법')
  })

  it('범위 밖 spellNo는 undefined를 반환한다', () => {
    expect(spellByNo(56)).toBeUndefined()
    expect(spellByNo(-1)).toBeUndefined()
  })
})

describe('read-only 데이터 경계 (완료 기준 5)', () => {
  it('catalog 모듈은 study/teach/learn/grow write 로직을 export하지 않는다', () => {
    // realm 성장·학습 write는 이 read-only 데이터 모듈의 책임이 아니다(후속 Story).
    const writeLike = Object.keys(catalogModule).filter((k) =>
      /study|teach|learn|grow|train|write|set|update|mutate/i.test(k),
    )
    expect(writeLike).toEqual([])
  })
})
