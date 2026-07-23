import type { GoldenFixture } from '../types.js'
import type { WeightNode } from '../../economy/carry.js'
import { makeManualFixture, writeFixtureFile } from './fixtureIo.js'

// 재생성 명령이 `import { buildFixture, writeFixtureFile }`로 소비하므로 writer를 re-export한다.
export { writeFixtureFile }

/**
 * carry(재귀 무게 합 weightOf) 골든 fixture 생성기 — manual oracle의 독립 참조 구현(A8 §8/§13).
 *
 * 원본 `object.c` `weight_obj`의 재귀 무게 합을 참조 구현(`referenceWeightOf`)으로 옮기고,
 * 손 계산으로 확정한 5개 케이스를 fixture로 감싸 `fixtures/carry.json`에 기록한다. 산술 정본은
 * 런타임 `economy/carry.ts`의 `weightOf`(직접 SUT 산술)에 둔다. maxWeight·개수 상한은 각각
 * `max_weight.json`·단위 테스트가 이미 커버하므로 이 fixture는 **novel한 OWTLES 재귀**에만 집중한다.
 *
 * ## anti-tautology: SUT와 독립 표현
 * SUT(`carry.ts`의 `weightOf`)는 가변 누적 변수 `n`과 명시적 `for` 루프로 합산한다. 이 참조는
 * `contents.reduce`로 자식을 접어(fold) 재귀 합을 표현한다 — 결과는 동일, 표현만 다르다.
 * SUT 함수(`weightOf`)를 import·호출하지 않는다(타입 `WeightNode`만 재사용).
 *
 * ## 결정적 함정: OWTLES 자식 서브트리 전체 제외
 * `weight_obj`는 자식마다 OWTLES를 검사한다. OWTLES 자식은 자기 무게 + 내용물 전체가 빠진다
 * (index 2 케이스: 10, 15·115 아님). 최상위 노드 자신의 무게는 weightless여도 항상 계산된다
 * (index 4 케이스: 8) — OWTLES 플래그는 부모만 판독하기 때문이다.
 *
 * ## 재생성 (수동 트리거)
 * `expected`·`generatedAt`은 체크인 후 frozen이며, 회귀 테스트 중 자동 재생성은 없다.
 * bare `node`는 상대 import의 `.js`→`.ts`를 해석하지 못하므로 TS-aware 러너로 재생성한다.
 * 임시 테스트를 vitest로 1회 실행하고 제거한다:
 *
 * ```
 * cd packages/shared
 * cat > src/oracle/generators/__regen.test.ts <<'EOF'
 * import { it } from 'vitest'
 * import { buildFixture, writeFixtureFile } from './carryFixture.js'
 * it('regen', () => {
 *   writeFixtureFile('./src/oracle/fixtures/carry.json',
 *     buildFixture(() => new Date('2026-07-13T00:00:00.000Z')))
 * })
 * EOF
 * pnpm exec vitest run src/oracle/generators/__regen.test.ts
 * rm src/oracle/generators/__regen.test.ts
 * ```
 */

/**
 * weightOf 참조 구현 — `object.c` `weight_obj`를 reduce fold 스타일로 옮긴다.
 *
 * SUT(`carry.ts`의 `weightOf`)와 표현을 분리한다: 여기선 가변 누적 대신 `contents.reduce`로
 * 자식 무게를 접는다. OWTLES 자식은 누적에서 통째로 건너뛰고, 노드 자신의 무게는 항상 더한다.
 */
export function referenceWeightOf(node: WeightNode): number {
  return node.contents.reduce(
    (sum, child) => (child.weightless ? sum : sum + referenceWeightOf(child)),
    node.weight,
  )
}

/** WeightNode 구성 헬퍼 — weightless·contents 기본값을 채운다. */
function node(weight: number, weightless = false, contents: WeightNode[] = []): WeightNode {
  return { weight, weightless, contents }
}

/** fixture 한 case의 형태. input은 SUT `weightOf`가 받는 WeightNode 트리다. */
type CarryCase = { input: WeightNode; expected: number; note?: string }

/** expected를 채우기 전의 case 초안. */
type CarryCaseDraft = Omit<CarryCase, 'expected'>

/**
 * 골든 케이스 5개를 구성한다. expected는 생성기 정상 경로대로 `referenceWeightOf`로 채운다.
 * (테스트 측 Layer B 앵커는 이와 독립적으로 손 계산 하드 리터럴 [10,18,10,18,8]을 사용한다.)
 */
export function buildCases(): CarryCase[] {
  const inputs: CarryCaseDraft[] = [
    { input: node(10), note: 'flat (자기 무게만 → 10)' },
    {
      input: node(10, false, [node(5, false, [node(3)])]),
      note: '중첩 non-weightless (10+5+3 → 18)',
    },
    {
      input: node(10, false, [node(5, true, [node(100)])]),
      note: 'OWTLES discriminator — 자식+내용물 전체 제외 (10, 15·115 아님)',
    },
    {
      input: node(10, false, [node(5, false), node(7, true), node(3, false)]),
      note: '형제 혼합 — weightless 형제(7)만 제외 (10+5+3 → 18)',
    },
    { input: node(8, true, []), note: '최상위 weightless도 자기 무게 계산 (8)' },
  ]

  return inputs.map((c) => ({ ...c, expected: referenceWeightOf(c.input) }))
}

/**
 * 케이스를 골든 fixture로 감싼다. `generatedAt`은 주입 clock으로 스탬프해 결정적으로 만든다.
 */
export function buildFixture(clock: () => Date): GoldenFixture<WeightNode, number> {
  return makeManualFixture('carry', 'object.c weight_obj (A8 §8/§13 재귀 무게 합)', buildCases(), clock)
}
