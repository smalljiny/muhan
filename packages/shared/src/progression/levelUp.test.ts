import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { upLevel, downLevel } from './levelUp.js'
import { resolveHpMax, resolveMpMax } from './maxResolvers.js'
import { goldenFixtureSchema } from '../oracle/types.js'
import type { GoldenFixture } from '../oracle/types.js'
import { approve } from '../oracle/runner.js'
import type { LevelCycleCaseInput } from '../oracle/generators/levelCycleFixture.js'
import type { Character } from '../schema/character.js'

/**
 * upLevel/downLevel(레벨업·강등 순수 변이) 테스트.
 *
 * 성장 게이트 newLevel%4==0, 슬롯 index=(newLevel-2)%10, enum→stats 매핑 v-1을 고정한다.
 * 최대치는 매 레벨 폐형 재동기화(D3), hpCurrent는 미상승·클램프다운(D4 발산)만 검증한다.
 */

/** class·level·stats만 관심사인 최소 유효 Character. 나머지 required 필드는 더미로 채운다. */
function makeChar(overrides: Partial<Character>): Character {
  const base: Character = {
    _id: 'char-1',
    name: '테스토스',
    class: 4,
    race: 0,
    stats: [10, 10, 10, 10, 10],
    gold: 0,
    currentRoom: 1,
    hpCurrent: 1,
    mpCurrent: 1,
    level: 1,
    experience: 0,
    // v5 spell store 시드(빈 지식 비트마스크·realm [0,0,0,0]) — Character required 필드 충족.
    spells: new Array<number>(16).fill(0),
    realm: [0, 0, 0, 0],
    schemaVersion: 3,
    accountId: 'acc-1',
    status: 'active',
    alignment: 1,
  }
  return { ...base, ...overrides }
}

describe('upLevel — 성장 게이트 (newLevel%4)', () => {
  it('newLevel%4≠0이면 stats 불변, 최대치만 재동기화한다 (L1→2)', () => {
    const before = makeChar({ class: 4, level: 1, stats: [10, 11, 12, 13, 14], hpCurrent: 5, mpCurrent: 5 })
    const after = upLevel(before)
    expect(after.level).toBe(2)
    expect(after.stats).toEqual([10, 11, 12, 13, 14])
    // hpCurrent는 미상승, 새 최대치 클램프만. L2 최대치는 L1보다 크므로 hpCurrent 그대로.
    expect(after.hpCurrent).toBe(5)
    expect(after.mpCurrent).toBe(5)
  })

  it('newLevel%4==0이면 level_cycle 슬롯 대상 stat 하나만 +1 한다 (L3→4, fighter index2=DEX)', () => {
    // newLevel=4, index=(4-2)%10=2, level_cycle[4][2]=2(DEX) → stats[1]+1
    const before = makeChar({ class: 4, level: 3, stats: [10, 10, 10, 10, 10] })
    const after = upLevel(before)
    expect(after.level).toBe(4)
    expect(after.stats).toEqual([10, 11, 10, 10, 10])
  })

  it('newLevel%4==0 대상 stat은 정확히 하나만 바뀐다 (L7→8, fighter index6=INT)', () => {
    // newLevel=8, index=(8-2)%10=6, level_cycle[4][6]=4(INT) → stats[3]+1
    const before = makeChar({ class: 4, level: 7, stats: [10, 10, 10, 10, 10] })
    const after = upLevel(before)
    expect(after.level).toBe(8)
    expect(after.stats).toEqual([10, 10, 10, 11, 10])
  })

  it('성장 대상은 클래스 행의 슬롯 값으로 정해진다 (mage=5·barbarian=2 L3→4 index2=PTY)', () => {
    // 두 클래스 모두 row[2]=5(PTY) → stats[4]. 클래스별 분기(index2에서 값이 갈리는 예)는
    // 골든 fixture 분포와 fighter(index2=DEX) 케이스가 커버한다.
    const mage = upLevel(makeChar({ class: 5, level: 3, stats: [1, 1, 1, 1, 1] }))
    expect(mage.stats).toEqual([1, 1, 1, 1, 2])
    const barb = upLevel(makeChar({ class: 2, level: 3, stats: [1, 1, 1, 1, 1] }))
    expect(barb.stats).toEqual([1, 1, 1, 1, 2])
  })

  it('최대치를 새 레벨 폐형으로 매번 재동기화한다(%4 게이트 없음)', () => {
    // L1→2는 성장 없지만 최대치는 새 레벨로 재계산된다.
    const before = makeChar({ class: 4, level: 1, hpCurrent: 999, mpCurrent: 999 })
    const after = upLevel(before)
    // hpCurrent는 미상승, 새 최대치로 클램프. resolveHpMax(L2)로 클램프되어야 한다.
    expect(after.hpCurrent).toBe(resolveHpMax({ class: 4, level: 2 }))
    expect(after.mpCurrent).toBe(resolveMpMax({ class: 4, level: 2 }))
  })

  it('level_cycle 값 0(row 0 placeholder)이면 %4 경계라도 stats 불변이다', () => {
    // class 0은 성장 슬롯이 전부 0 → statValue<1 방어 경로. L3→4 경계에서도 무변화.
    const before = makeChar({ class: 0, level: 3, stats: [7, 7, 7, 7, 7] })
    const after = upLevel(before)
    expect(after.level).toBe(4)
    expect(after.stats).toEqual([7, 7, 7, 7, 7])
  })

  it('나머지 필드를 스프레드 보존하고 새 stats 배열을 반환한다(불변성)', () => {
    const before = makeChar({ class: 4, level: 3, name: '보존체크', gold: 777, accountId: 'acc-x' })
    const after = upLevel(before)
    expect(after.name).toBe('보존체크')
    expect(after.gold).toBe(777)
    expect(after.accountId).toBe('acc-x')
    expect(after._id).toBe(before._id)
    // 새 객체·새 배열(원본 불변).
    expect(after).not.toBe(before)
    expect(after.stats).not.toBe(before.stats)
    expect(before.stats).toEqual([10, 10, 10, 10, 10])
  })
})

describe('downLevel — 강등 게이트 (char.level%4)', () => {
  it('char.level%4≠0이면 stats 불변 (L2→1)', () => {
    const before = makeChar({ class: 4, level: 2, stats: [10, 11, 12, 13, 14] })
    const after = downLevel(before)
    expect(after.level).toBe(1)
    expect(after.stats).toEqual([10, 11, 12, 13, 14])
  })

  it('char.level%4==0이면 슬롯 대상 stat 하나만 -1 (L4→3, fighter index2=DEX)', () => {
    // char.level=4, index=(4-2)%10=2, level_cycle[4][2]=2(DEX) → stats[1]-1
    const before = makeChar({ class: 4, level: 4, stats: [10, 11, 10, 10, 10] })
    const after = downLevel(before)
    expect(after.level).toBe(3)
    expect(after.stats).toEqual([10, 10, 10, 10, 10])
  })
})

describe('inverse property — downLevel(upLevel(char)) 원복', () => {
  it('level·stats가 대표 레벨 시퀀스에서 원복된다(%4 경계 포함)', () => {
    for (const characterClass of [1, 2, 4, 5, 9]) {
      for (let level = 3; level <= 40; level++) {
        const before = makeChar({ class: characterClass, level, stats: [12, 13, 14, 15, 16] })
        const round = downLevel(upLevel(before))
        expect(round.level).toBe(before.level)
        expect(round.stats).toEqual(before.stats)
      }
    }
  })
})

describe('hpCurrent 불변식 (D4: 미상승·클램프다운)', () => {
  it('upLevel 후 hpCurrent ≤ resolveHpMax, 정상 레벨업에서 미상승', () => {
    const before = makeChar({ class: 4, level: 5, hpCurrent: 3, mpCurrent: 2 })
    const after = upLevel(before)
    expect(after.hpCurrent).toBeLessThanOrEqual(resolveHpMax(after))
    // oldHpCurrent(3) < newMax이므로 그대로 유지(미상승).
    expect(after.hpCurrent).toBe(3)
    expect(after.mpCurrent).toBe(2)
  })

  it('downLevel에서 최대치가 하락하면 hpCurrent를 클램프다운한다', () => {
    // hpCurrent=maxHp인 캐릭터를 강등하면 새(작은) max로 내려간다.
    const maxHpAt6 = resolveHpMax({ class: 4, level: 6 })
    const maxMpAt6 = resolveMpMax({ class: 4, level: 6 })
    const before = makeChar({ class: 4, level: 6, hpCurrent: maxHpAt6, mpCurrent: maxMpAt6 })
    const after = downLevel(before)
    const newMaxHp = resolveHpMax({ class: 4, level: 5 })
    const newMaxMp = resolveMpMax({ class: 4, level: 5 })
    expect(after.hpCurrent).toBe(newMaxHp)
    expect(after.mpCurrent).toBe(newMaxMp)
    expect(after.hpCurrent).toBeLessThan(maxHpAt6)
    expect(after.hpCurrent).toBeLessThanOrEqual(resolveHpMax(after))
  })
})

// ---------------------------------------------------------------------------
// 골든 fixture 회귀 — 클래스별 40레벨 upLevel 반복 성장 분포 (level_cycle SUT)
// ---------------------------------------------------------------------------

/** 체크인된 level_cycle 골든 fixture를 로드한다. cases input/expected는 스키마상 unknown. */
function loadFixture(): GoldenFixture<LevelCycleCaseInput, number[]> {
  const url = new URL('../oracle/fixtures/level_cycle.json', import.meta.url)
  const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
  return goldenFixtureSchema.parse(parsed) as GoldenFixture<LevelCycleCaseInput, number[]>
}

/** SUT: base 0 stats 레벨1 캐릭터에 upLevel을 targetLevel까지 반복해 최종 stats(=누적 성장)를 반환. */
function levelUpGainsSut(input: LevelCycleCaseInput): number[] {
  let char = makeChar({ class: input.characterClass, level: 1, stats: [0, 0, 0, 0, 0] })
  while (char.level < input.targetLevel) {
    char = upLevel(char)
  }
  return [...char.stats]
}

describe('골든 fixture 회귀 (level_cycle upLevel 성장 분포)', () => {
  it('approve(level_cycle fixture, SUT)가 전 케이스를 throw 없이 통과한다', () => {
    const fixture = loadFixture()
    expect(() => approve(fixture, levelUpGainsSut)).not.toThrow()
  })

  it('성장 슬롯을 한 칸 밀어 왜곡한 변형에는 approve가 throw한다(negative control)', () => {
    const fixture = loadFixture()
    // stats를 한 칸 회전시켜 분포를 왜곡한다 — 골든과 반드시 불일치.
    const buggy = (input: LevelCycleCaseInput): number[] => {
      const g = levelUpGainsSut(input)
      return [g[4]!, g[0]!, g[1]!, g[2]!, g[3]!]
    }
    expect(() => approve(fixture, buggy)).toThrow()
  })
})
