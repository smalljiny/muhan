import type { GoldenFixture } from '../types.js'
import type { EffectiveStatContext } from '../../stats/context.js'
import { classStatOf } from '../../stats/tables.js'
import { makeManualFixture, writeFixtureFile } from './fixtureIo.js'

// 재생성 명령이 `import { buildFixture, writeFixtureFile }`로 소비하므로 writer를 re-export한다.
export { writeFixtureFile }

/**
 * compute_mpmax(최대 MP) 골든 fixture 생성기 — manual oracle의 독립 참조 구현.
 *
 * 원본 `player.c:806`(up_level)의 MP 성장 폐형을 참조 구현(`referenceComputeMpMax`)으로
 * 옮기고, A7 §2 손 계산으로 확정한 6개 케이스를 fixture로 감싸 `fixtures/compute_mpmax.json`에
 * 기록한다. Story 5는 산술 정본을 **런타임 `stats/derived.ts`의 `computeMpMax`**에 둔다
 * (직접 SUT 산술). 이 참조는 그 SUT와 **독립 표현**으로 작성한다 — 곱을 중간 변수로 뽑아
 * `Math.floor`로 나누고, SUT는 인라인 `Math.trunc`.
 *
 * ## 결정적 함정: 정수 나눗셈 그룹핑
 * `mp * (level-1) / 2`는 `(mp*(level-1))/2`이며 truncation은 곱 결과에 적용된다. 도술사
 * L50 → 123(= 50 + trunc(3*49/2) = 50+73)이 이 그룹핑을 검증하는 앵커다.
 *
 * ## 재생성 (수동 트리거)
 * `expected`·`generatedAt`은 체크인 후 frozen이며, 회귀 테스트 중 자동 재생성은 없다.
 *
 * ```
 * cd packages/shared
 * node --input-type=module -e "import { buildFixture, writeFixtureFile } from './src/oracle/generators/computeMpMaxFixture.ts'; writeFixtureFile('./src/oracle/fixtures/compute_mpmax.json', buildFixture(() => new Date('2026-07-13T00:00:00.000Z')))"
 * ```
 */

/**
 * compute_mpmax 참조 구현 — `player.c:806` 정공식을 SUT와 독립 표현으로 옮긴다.
 *
 * SUT(`derived.ts`의 `computeMpMax`)는 인라인 `Math.trunc((mp*(level-1))/2)`를 쓰지만,
 * 여기선 곱을 명시 중간 변수 `product`로 분리하고 `Math.floor(product/2)`로 나눈다(level>=1
 * 이라 product>=0, 값은 동일·표현만 다름). start/growth는 `classStatOf`로 판독한다.
 */
export function referenceComputeMpMax(context: EffectiveStatContext): number {
  const start = classStatOf({ classIndex: context.characterClass, field: 'mpstart' })
  const growth = classStatOf({ classIndex: context.characterClass, field: 'mp' })
  const product = growth * (context.level - 1)
  return start + Math.floor(product / 2)
}

/** fixture 한 case의 형태. input은 SUT `computeMpMax`가 받는 전체 컨텍스트다. */
type ComputeMpMaxCase = { input: EffectiveStatContext; expected: number; note?: string }

/** expected를 채우기 전의 case 초안. */
type ComputeMpMaxCaseDraft = Omit<ComputeMpMaxCase, 'expected'>

/**
 * compute_mpmax가 판독하지 않는 컨텍스트 필드를 더미값으로 채워 전체 컨텍스트를 구성한다.
 * 판독 필드(characterClass·level)만 overrides로 지정한다.
 */
function ctx(overrides: { characterClass: number; level: number }): EffectiveStatContext {
  return {
    effectiveDexterity: 0,
    effectiveStrength: 0,
    equipArmor: 0,
    protection: false,
    weaponAdjustment: 0,
    weaponProficiency: 0,
    ...overrides,
  }
}

/**
 * 골든 케이스 6개를 구성한다. expected는 생성기 정상 경로대로 `referenceComputeMpMax`로 채운다.
 * (테스트 측 Layer B 앵커는 이와 독립적으로 A7 §2 손 계산 하드 리터럴로 tautology를 차단한다.)
 */
export function buildCases(): ComputeMpMaxCase[] {
  const inputs: ComputeMpMaxCaseDraft[] = [
    { input: ctx({ characterClass: 4, level: 10 }), note: 'A7 §2 검사 L10' },
    { input: ctx({ characterClass: 4, level: 50 }), note: 'A7 §2 검사 L50' },
    { input: ctx({ characterClass: 4, level: 100 }), note: 'A7 §2 검사 L100' },
    { input: ctx({ characterClass: 5, level: 50 }), note: 'A7 §2 도술사 L50 (그룹핑 앵커 123)' },
    { input: ctx({ characterClass: 2, level: 50 }), note: 'A7 §2 권법가 L50' },
    { input: ctx({ characterClass: 5, level: 1 }), note: 'A7 §2 도술사 L1 (성장항 0)' },
  ]

  return inputs.map((c) => ({ ...c, expected: referenceComputeMpMax(c.input) }))
}

/**
 * 케이스를 골든 fixture로 감싼다. `generatedAt`은 주입 clock으로 스탬프해 결정적으로 만든다.
 */
export function buildFixture(clock: () => Date): GoldenFixture<EffectiveStatContext, number> {
  return makeManualFixture('compute_mpmax', 'player.c:806 (A7 §2 up_level MP)', buildCases(), clock)
}
