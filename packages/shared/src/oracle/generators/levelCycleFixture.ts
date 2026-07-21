import type { GoldenFixture } from '../types.js'
import { level_cycle } from '../../progression/tables.js'
import { makeManualFixture, writeFixtureFile } from './fixtureIo.js'

// 재생성 명령이 `import { buildFixture, writeFixtureFile }`로 소비하므로 writer를 re-export한다.
export { writeFixtureFile }

/**
 * level_cycle(레벨업 능력치 성장 분포) 골든 fixture 생성기 — manual oracle의 독립 참조 구현.
 *
 * 원본 `global.c:78`(level_cycle) + `player.c:770`(up_level 성장 게이트)의 동작을 참조 구현
 * (`referenceLevelCycleGains`)으로 옮기고, 클래스 1-9의 "레벨 1→40 upLevel 반복 누적 성장
 * 분포"를 fixture로 감싸 `fixtures/level_cycle.json`에 기록한다. 런타임 정본은 `progression/
 * levelUp.ts`의 `upLevel`(SUT)이며, 이 참조는 그 SUT와 **독립 표현**으로 작성한다 — SUT는
 * Character를 매 레벨 순차 변이하지만, 여기선 성장 레벨 집합을 `filter`로 유도하고 슬롯 값
 * 히스토그램을 `reduce`로 누적한다(값 동일·표현만 다름). level_cycle 테이블 자체는
 * `progression/tables.ts`에서 import한다(재전사 금지).
 *
 * ## 결정적 함정: 성장 슬롯은 항상 짝수
 * 성장은 newLevel%4==0에서만 발화하고 슬롯 index=(newLevel-2)%10은 항상 짝수라, level_cycle
 * 홀수 슬롯은 이 분포에 절대 기여하지 않는다. 홀수 슬롯 전사 오류는 이 골든으로 잡히지 않으며,
 * `tables.test.ts`의 셀 단위 하드 리터럴 대조가 그 몫을 담당한다.
 *
 * ## 재생성 (수동 트리거)
 * `expected`·`generatedAt`은 체크인 후 frozen이며, 회귀 테스트 중 자동 재생성은 없다.
 *
 * ```
 * cd packages/shared
 * node --input-type=module -e "import { buildFixture, writeFixtureFile } from './src/oracle/generators/levelCycleFixture.ts'; writeFixtureFile('./src/oracle/fixtures/level_cycle.json', buildFixture(() => new Date('2026-07-21T00:00:00.000Z')))"
 * ```
 */

/**
 * level_cycle 성장 분포 참조 구현 — SUT(`upLevel` 반복)와 독립 표현.
 *
 * SUT는 레벨 1→targetLevel을 순차 변이하며 매 스텝 게이트를 판정하지만, 여기선 성장이 발화하는
 * 레벨 집합(2..targetLevel 중 %4==0)을 `filter`로 한 번에 유도하고, 각 성장 레벨의 슬롯 값
 * v=level_cycle[class][(lvl-2)%10]을 stats 히스토그램(index v-1)에 `reduce`로 누적한다.
 * base stats 0에서 출발하므로 최종 stats == 누적 성장 분포다.
 */
export function referenceLevelCycleGains(characterClass: number, targetLevel: number): number[] {
  const gains = [0, 0, 0, 0, 0]
  const row = level_cycle.at(characterClass)
  if (row === undefined) return gains
  const growthLevels = Array.from({ length: targetLevel - 1 }, (_, i) => i + 2).filter(
    (lvl) => lvl % 4 === 0,
  )
  return growthLevels.reduce((acc, lvl) => {
    const v = row.at((lvl - 2) % 10) ?? 0
    if (v >= 1) acc[v - 1] = (acc[v - 1] ?? 0) + 1
    return acc
  }, gains)
}

/** fixture 한 case의 input — 클래스와 목표 레벨(1→targetLevel까지 upLevel 반복). */
export type LevelCycleCaseInput = { characterClass: number; targetLevel: number }

/** fixture 한 case의 형태. expected는 5-tuple stats 누적 성장 분포. */
type LevelCycleCase = { input: LevelCycleCaseInput; expected: number[]; note?: string }

/** expected를 채우기 전의 case 초안. */
type LevelCycleCaseDraft = Omit<LevelCycleCase, 'expected'>

/**
 * 골든 케이스 9개(클래스 1-9, 레벨 1→40)를 구성한다. expected는 참조 구현으로 채운다.
 * (테스트 측 Layer B 앵커는 이와 독립적으로 확정 정본 하드 리터럴로 tautology를 차단한다.)
 */
export function buildCases(): LevelCycleCase[] {
  const inputs: LevelCycleCaseDraft[] = [
    { input: { characterClass: 1, targetLevel: 40 }, note: 'assassin L1→40 성장 분포' },
    { input: { characterClass: 2, targetLevel: 40 }, note: 'barbarian L1→40 성장 분포' },
    { input: { characterClass: 3, targetLevel: 40 }, note: 'cleric L1→40 성장 분포' },
    { input: { characterClass: 4, targetLevel: 40 }, note: 'fighter L1→40 성장 분포' },
    { input: { characterClass: 5, targetLevel: 40 }, note: 'mage L1→40 성장 분포' },
    { input: { characterClass: 6, targetLevel: 40 }, note: 'paladin L1→40 성장 분포' },
    { input: { characterClass: 7, targetLevel: 40 }, note: 'ranger L1→40 성장 분포' },
    { input: { characterClass: 8, targetLevel: 40 }, note: 'thief L1→40 성장 분포' },
    { input: { characterClass: 9, targetLevel: 40 }, note: 'invincible L1→40 균등 분포' },
  ]

  return inputs.map((c) => ({
    ...c,
    expected: referenceLevelCycleGains(c.input.characterClass, c.input.targetLevel),
  }))
}

/**
 * 케이스를 골든 fixture로 감싼다. `generatedAt`은 주입 clock으로 스탬프해 결정적으로 만든다.
 */
export function buildFixture(clock: () => Date): GoldenFixture<LevelCycleCaseInput, number[]> {
  return makeManualFixture(
    'level_cycle',
    'global.c:78 level_cycle / player.c:770 up_level',
    buildCases(),
    clock,
  )
}
