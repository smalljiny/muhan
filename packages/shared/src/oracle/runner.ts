import { isDeepStrictEqual, inspect } from 'node:util'
import type { GoldenFixture } from './types.js'

/**
 * 골든 fixture approval 러너 — 체크인 fixture의 cases를 SUT 출력과 대조한다.
 *
 * `fixture.cases`를 순회하며 각 case의 `input`으로 `sut`를 실행하고 `expected`와
 * 대조한다. 불일치가 하나도 없으면 정상 반환(void), 하나 이상이면 수집된 전 불일치를
 * 집계한 메시지로 Error를 throw한다.
 *
 * ## fail-fast 금지
 * 첫 불일치에서 멈추지 않고 전 케이스를 끝까지 순회해 모든 불일치를 수집한다.
 * 회귀 한 번에 얼마나 광범위하게 깨졌는지를 케이스 단위 diff로 한눈에 보기 위함이다.
 *
 * ## 동등 비교 전략 — node util.isDeepStrictEqual
 * compute_ac류 대상 함수는 number를 반환해 표면상 `===`로 충분하지만, 이 러너는
 * 제네릭이라 객체·배열 출력도 받는다. `===`는 구조가 같아도 참조가 다른 객체를
 * 불일치로 오판하므로 구조적(structural) 동등 비교가 필요하다. `JSON.stringify` 비교는
 * 키 순서 의존·`undefined` 손실·`NaN`→`null` 왜곡 문제가 있어, 중첩 구조와 특수값에
 * 더 견고한 `node:util`의 `isDeepStrictEqual`을 채택한다.
 */
export function approve<I, O>(fixture: GoldenFixture<I, O>, sut: (input: I) => O): void {
  // boundary 가드 — 빈 cases는 mismatches가 0건이라 무조건 통과하는 vacuous-pass다.
  // goldenFixtureSchema는 .min(1)로 이를 막지만, approve는 파싱을 거치지 않고 캐스팅된
  // fixture도 받는 공개 재사용 러너이므로 여기서 defense-in-depth로 다시 거부한다.
  if (fixture.cases.length === 0) {
    throw new Error(`골든 fixture '${fixture.fn}' 빈 cases: 대조할 케이스가 없다(vacuous-pass 방지)`)
  }

  // 불일치 케이스만 수집한다 — {index, input, expected, actual}.
  const mismatches: { index: number; input: I; expected: O; actual: O }[] = []

  fixture.cases.forEach((testCase, index) => {
    const actual = sut(testCase.input)
    if (!isDeepStrictEqual(actual, testCase.expected)) {
      mismatches.push({ index, input: testCase.input, expected: testCase.expected, actual })
    }
  })

  if (mismatches.length === 0) return

  // 요약 한 줄 + 케이스별 diff 블록으로 읽기 쉬운 메시지를 조립한다.
  // 직렬화는 node:util.inspect를 쓴다 — JSON.stringify는 NaN·undefined를 왜곡하고
  // BigInt·순환참조에서 throw해 실제 불일치 에러를 가리므로, 비교와 동일한 계열의
  // 견고한 렌더러로 통일한다.
  const render = (v: unknown) => inspect(v, { depth: null, breakLength: Infinity })
  const total = fixture.cases.length
  const summary = `골든 fixture '${fixture.fn}' 불일치: ${total}개 케이스 중 ${mismatches.length}개 불일치`
  const details = mismatches
    .map(
      (m) =>
        `  - case index ${m.index}: input=${render(m.input)} expected=${render(
          m.expected,
        )} actual=${render(m.actual)}`,
    )
    .join('\n')

  throw new Error(`${summary}\n${details}`)
}
