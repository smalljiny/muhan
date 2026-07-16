import type { GoldenFixture } from '../types.js'
import type { EffectiveStatContext } from '../../stats/context.js'
import { thacoOf, bonusOf, proficDivisorOf } from '../../stats/tables.js'
import { makeManualFixture, writeFixtureFile } from './fixtureIo.js'

// 재생성 명령이 `import { buildFixture, writeFixtureFile }`로 소비하므로 writer를 re-export한다.
export { writeFixtureFile }

/**
 * compute_thaco(명중·THAC0) 골든 fixture 생성기 — manual oracle의 독립 참조 구현.
 *
 * 원본 `player.c:1001`의 THAC0 공식을 참조 구현(`referenceComputeThaco`)으로 옮기고,
 * 손 계산으로 확정한 9개 케이스를 fixture로 감싸 `fixtures/compute_thaco.json`에 기록한다.
 * Story 4는 산술 정본을 `oracle/*`가 아닌 **런타임 `stats/derived.ts`의 `computeThaco`**에
 * 둔다(직접 SUT 산술). 이 참조는 그 SUT와 **독립 표현**으로 작성해 판별력을 유지한다 —
 * 여기선 step-array reduce + 테이블 기반 하한, SUT는 직접 차감 체인 + if/return 분기.
 *
 * ## 재생성 (수동 트리거)
 * `expected`·`generatedAt`은 체크인 후 frozen이며, 회귀 테스트 중 자동 재생성은 없다.
 * fixture를 다시 스탬프하려면 사람이 아래 명령을 직접 실행한다(고정 clock으로 결정적):
 *
 * ```
 * cd packages/shared
 * node --input-type=module -e "import { buildFixture, writeFixtureFile } from './src/oracle/generators/computeThacoFixture.ts'; writeFixtureFile('./src/oracle/fixtures/compute_thaco.json', buildFixture(() => new Date('2026-07-13T00:00:00.000Z')))"
 * ```
 */

/**
 * compute_thaco 참조 구현 — `player.c:1001` 정공식을 step-array 누적 스타일로 옮긴다.
 *
 * SUT(`derived.ts`의 `computeThaco`)와 표현을 분리해 판별력을 유지한다:
 * - circle 계산: `Math.floor` + 삼항 clamp (SUT는 `Math.trunc` + `Math.max/min`).
 * - 차감: step 배열 reduce (SUT는 가변 누적 변수 차감 체인).
 * - 최종 clamp: 하한값 테이블 조회 후 `Math.max` (SUT는 if/return 3분기).
 */
export function referenceComputeThaco(context: EffectiveStatContext): number {
  const { effectiveStrength, characterClass, level, weaponAdjustment, weaponProficiency } = context

  // circle = [1,20]로 clamp된 trunc((level+3)/4). levelIndex는 circle-1(0-based).
  const rawCircle = Math.floor((level + 3) / 4)
  const circle = rawCircle < 1 ? 1 : rawCircle > 20 ? 20 : rawCircle
  const levelIndex = circle - 1

  const steps: number[] = []
  steps.push(thacoOf({ classIndex: characterClass, levelIndex }))
  steps.push(-weaponAdjustment)
  steps.push(-Math.trunc(weaponProficiency / proficDivisorOf(characterClass)))
  steps.push(-bonusOf(effectiveStrength))

  let thaco = 0
  for (const step of steps) {
    thaco += step
  }

  // 최종 clamp 3분기 (CARETAKER=10 기준): 하한값을 테이블로 조회한다.
  //   class>=10                → 하한 -10
  //   class<10 && level>=101   → 하한 -5
  //   class<10 && level<101    → 하한 0
  const lowerBound = characterClass >= 10 ? -10 : level >= 101 ? -5 : 0
  return Math.max(lowerBound, thaco)
}

/** fixture 한 case의 형태. input은 SUT `computeThaco`가 받는 전체 컨텍스트다. */
type ComputeThacoCase = { input: EffectiveStatContext; expected: number; note?: string }

/** expected를 채우기 전의 case 초안. */
type ComputeThacoCaseDraft = Omit<ComputeThacoCase, 'expected'>

/**
 * compute_thaco가 판독하지 않는 컨텍스트 필드(effectiveDexterity·equipArmor·protection)를
 * 더미값으로 채워 전체 `EffectiveStatContext`를 구성한다. 판독 필드만 overrides로 지정한다.
 */
function ctx(overrides: {
  effectiveStrength: number
  characterClass: number
  level: number
  weaponAdjustment: number
  weaponProficiency: number
}): EffectiveStatContext {
  return {
    effectiveDexterity: 0,
    equipArmor: 0,
    protection: false,
    ...overrides,
  }
}

/**
 * 골든 케이스 9개를 구성한다. expected는 생성기 정상 경로대로 `referenceComputeThaco`로 채운다.
 * (테스트 측 Layer B 앵커는 이와 독립적으로 손 계산 하드 리터럴을 사용해 tautology를 차단한다.)
 */
export function buildCases(): ComputeThacoCase[] {
  const inputs: ComputeThacoCaseDraft[] = [
    {
      input: ctx({ effectiveStrength: 10, characterClass: 4, level: 1, weaponAdjustment: 0, weaponProficiency: 0 }),
      note: 'A7 앵커 fighter L1',
    },
    {
      input: ctx({ effectiveStrength: 10, characterClass: 4, level: 77, weaponAdjustment: 0, weaponProficiency: 0 }),
      note: 'A7 앵커 fighter L77 (circle 20)',
    },
    {
      input: ctx({ effectiveStrength: 10, characterClass: 5, level: 1, weaponAdjustment: 0, weaponProficiency: 0 }),
      note: 'A7 앵커 mage L1',
    },
    {
      input: ctx({ effectiveStrength: 10, characterClass: 1, level: 1, weaponAdjustment: 0, weaponProficiency: 0 }),
      note: 'A7 앵커 assassin L1',
    },
    {
      input: ctx({ effectiveStrength: 10, characterClass: 2, level: 77, weaponAdjustment: 0, weaponProficiency: 100 }),
      note: 'class<10 L<101 하한 0 (mod_profic 5)',
    },
    {
      input: ctx({ effectiveStrength: 25, characterClass: 4, level: 40, weaponAdjustment: 2, weaponProficiency: 40 }),
      note: 'weaponAdjustment+strength bonus+mod_profic 차감',
    },
    {
      input: ctx({ effectiveStrength: 10, characterClass: 4, level: 101, weaponAdjustment: 10, weaponProficiency: 100 }),
      note: 'class<10 L>=101 하한 -5',
    },
    {
      input: ctx({ effectiveStrength: 10, characterClass: 10, level: 1, weaponAdjustment: 20, weaponProficiency: 0 }),
      note: 'class>=10 하한 -10',
    },
    {
      input: ctx({ effectiveStrength: 10, characterClass: 10, level: 1, weaponAdjustment: 0, weaponProficiency: 0 }),
      note: 'class>=10 비clamp',
    },
  ]

  return inputs.map((c) => ({ ...c, expected: referenceComputeThaco(c.input) }))
}

/**
 * 케이스를 골든 fixture로 감싼다. `generatedAt`은 주입 clock으로 스탬프해 결정적으로 만든다.
 */
export function buildFixture(clock: () => Date): GoldenFixture<EffectiveStatContext, number> {
  return makeManualFixture(
    'compute_thaco',
    'player.c:1001 (A7 §6 compute_thaco)',
    buildCases(),
    clock,
  )
}
