import type { GoldenFixture } from '../types.js'
import type { EffectiveStatContext } from '../../stats/context.js'
import { makeManualFixture, writeFixtureFile } from './fixtureIo.js'

// 재생성 명령이 `import { buildFixture, writeFixtureFile }`로 소비하므로 writer를 re-export한다.
export { writeFixtureFile }

/**
 * max_weight(최대 소지량) 골든 fixture 생성기 — manual oracle의 독립 참조 구현.
 *
 * 원본 `player.c:1099`의 최대 소지량 공식을 참조 구현(`referenceMaxWeight`)으로 옮기고,
 * 손 계산으로 확정한 6개 케이스를 fixture로 감싸 `fixtures/max_weight.json`에 기록한다.
 * Story 4는 산술 정본을 **런타임 `stats/derived.ts`의 `maxWeight`**에 둔다(직접 SUT 산술).
 * 이 참조는 그 SUT와 **독립 표현**으로 작성한다 — 여기선 순수 합(base + barbarian 항),
 * SUT는 가변 누적 변수 `n`.
 *
 * ## 결정적 함정: barbarian 항의 unclamped (level+3)/4
 * barbarian(class 2)만 `Math.trunc((level+3)/4)*10`을 가산하는데, 이 항의 `(level+3)/4`는
 * compute_thaco의 circle과 달리 `[1,20]` clamp가 **없다**(L>=81에서 발산). circle 헬퍼를
 * 재사용하면 안 된다. barbarian L81 str10 → 330(clamp하면 320)이 이 함정의 discriminator다.
 *
 * ## 재생성 (수동 트리거)
 * `expected`·`generatedAt`은 체크인 후 frozen이며, 회귀 테스트 중 자동 재생성은 없다.
 *
 * ```
 * cd packages/shared
 * node --input-type=module -e "import { buildFixture, writeFixtureFile } from './src/oracle/generators/maxWeightFixture.ts'; writeFixtureFile('./src/oracle/fixtures/max_weight.json', buildFixture(() => new Date('2026-07-13T00:00:00.000Z')))"
 * ```
 */

/**
 * max_weight 참조 구현 — `player.c:1099` 정공식을 순수 합 스타일로 옮긴다.
 *
 * SUT(`derived.ts`의 `maxWeight`)와 표현을 분리한다: 여기선 base + barbarian 항의 순수
 * 덧셈, SUT는 가변 누적. barbarian 항은 `Math.floor((level+3)/4)*10`으로 **clamp 없이**
 * 계산한다(SUT의 `Math.trunc`와 값은 동일, 표현만 다름). barbarian이 아니면 항은 0이다.
 */
export function referenceMaxWeight(context: EffectiveStatContext): number {
  const base = 20 + context.effectiveStrength * 10
  const barbarianTerm =
    context.characterClass === 2 ? Math.floor((context.level + 3) / 4) * 10 : 0
  return base + barbarianTerm
}

/** fixture 한 case의 형태. input은 SUT `maxWeight`가 받는 전체 컨텍스트다. */
type MaxWeightCase = { input: EffectiveStatContext; expected: number; note?: string }

/** expected를 채우기 전의 case 초안. */
type MaxWeightCaseDraft = Omit<MaxWeightCase, 'expected'>

/**
 * max_weight가 판독하지 않는 컨텍스트 필드를 더미값으로 채워 전체 컨텍스트를 구성한다.
 * 판독 필드(effectiveStrength·characterClass·level)만 overrides로 지정한다.
 */
function ctx(overrides: {
  effectiveStrength: number
  characterClass: number
  level: number
}): EffectiveStatContext {
  return {
    effectiveDexterity: 0,
    equipArmor: 0,
    protection: false,
    weaponAdjustment: 0,
    weaponProficiency: 0,
    ...overrides,
  }
}

/**
 * 골든 케이스 6개를 구성한다. expected는 생성기 정상 경로대로 `referenceMaxWeight`로 채운다.
 * (테스트 측 Layer B 앵커는 이와 독립적으로 손 계산 하드 리터럴을 사용해 tautology를 차단한다.)
 */
export function buildCases(): MaxWeightCase[] {
  const inputs: MaxWeightCaseDraft[] = [
    {
      input: ctx({ effectiveStrength: 10, characterClass: 2, level: 81 }),
      note: 'clamp 함정 discriminator (330, 320 아님)',
    },
    {
      input: ctx({ effectiveStrength: 10, characterClass: 4, level: 81 }),
      note: 'non-barbarian 고레벨 (barbarian 항 없음)',
    },
    {
      input: ctx({ effectiveStrength: 10, characterClass: 2, level: 1 }),
      note: 'barbarian 저레벨',
    },
    {
      input: ctx({ effectiveStrength: 18, characterClass: 2, level: 20 }),
      note: 'barbarian 중레벨·고str',
    },
    {
      input: ctx({ effectiveStrength: 0, characterClass: 4, level: 1 }),
      note: 'str0 하한',
    },
    {
      input: ctx({ effectiveStrength: 10, characterClass: 2, level: 400 }),
      note: 'unclamped 발산',
    },
  ]

  return inputs.map((c) => ({ ...c, expected: referenceMaxWeight(c.input) }))
}

/**
 * 케이스를 골든 fixture로 감싼다. `generatedAt`은 주입 clock으로 스탬프해 결정적으로 만든다.
 */
export function buildFixture(clock: () => Date): GoldenFixture<EffectiveStatContext, number> {
  return makeManualFixture('max_weight', 'player.c:1099 (A7 §6 max_weight)', buildCases(), clock)
}
