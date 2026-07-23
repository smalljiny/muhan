import type { GoldenFixture } from '../types.js'
import { makeManualFixture, writeFixtureFile } from './fixtureIo.js'

// 재생성 명령이 `import { buildFixture, writeFixtureFile }`로 소비하므로 writer를 re-export한다.
export { writeFixtureFile }

/**
 * 가격 배수 골든 fixture 생성기 — manual oracle의 독립 참조 구현(A8 §8).
 *
 * 원본 `command7.c:169`(구매)·`command7.c:258`(판매)·`command8.c:249`(수리)·
 * `command10.c:573`(몹구매)의 네 가격 공식을 참조 구현(`referencePrice`)으로 옮기고,
 * 손 계산으로 확정한 12개 케이스를 fixture로 감싸 `fixtures/price.json`에 기록한다.
 * 산술 정본은 런타임 `economy/priceConfig.ts`의 네 함수(직접 SUT 산술)에 둔다.
 *
 * ## GoldenFixture<I,O> 모델링: 4함수 dispatch
 * 대상이 네 함수(buy·mobBuy·sell·repair)인데 GoldenFixture는 단일 `fn`을 가정하므로,
 * fixture의 `fn`은 `'price'`로 두고 각 case의 `input`을 `{ fn, value }`로 모델링한다.
 * 참조 구현이 `input.fn`으로 디스패치해 한 함수만 실행한다 — 이렇게 하면 GoldenFixture<I,O>
 * 형태를 깨지 않고 네 함수를 한 fixture에 담을 수 있다.
 *
 * ## anti-tautology: SUT와 독립 표현
 * SUT(`priceConfig.ts`)는 `PRICE_CONFIG` 상수를 판독하고 `Math.trunc`로 절삭한다. 이 참조는
 * **인라인 리터럴**(`10`·`100000`·`/2`·`/4`)을 직접 쓰고 절삭은 `Math.floor`로 표현한다
 * (value 비음수라 값은 동일, 표현만 다름). 참조는 SUT를 import·호출하지 않는다.
 *
 * ## 재생성 (수동 트리거)
 * `expected`·`generatedAt`은 체크인 후 frozen이며, 회귀 테스트 중 자동 재생성은 없다.
 * bare `node`는 상대 import의 `.js`→`.ts`를 해석하지 못하므로(형상 경계 = vite 번들러
 * moduleResolution), TS-aware 러너로 재생성한다. 임시 테스트를 vitest로 1회 실행하고 제거한다:
 *
 * ```
 * cd packages/shared
 * cat > src/oracle/generators/__regen.test.ts <<'EOF'
 * import { it } from 'vitest'
 * import { buildFixture, writeFixtureFile } from './priceFixture.js'
 * it('regen', () => {
 *   writeFixtureFile('./src/oracle/fixtures/price.json',
 *     buildFixture(() => new Date('2026-07-13T00:00:00.000Z')))
 * })
 * EOF
 * pnpm exec vitest run src/oracle/generators/__regen.test.ts
 * rm src/oracle/generators/__regen.test.ts
 * ```
 */

/** fixture 한 case의 input 형태 — 어느 가격 함수를(`fn`) 어떤 정가(`value`)로 실행할지. */
export type PriceInput = { fn: 'buy' | 'mobBuy' | 'sell' | 'repair'; value: number }

/**
 * 가격 참조 구현 — 네 공식을 `input.fn`으로 디스패치한다.
 *
 * SUT(`priceConfig.ts`)와 표현을 분리한다: 여기선 `PRICE_CONFIG`를 참조하지 않고 상수를
 * 인라인 리터럴로 박고, 정수 절삭을 `Math.floor`로 표현한다(SUT는 `Math.trunc`).
 */
export function referencePrice(input: PriceInput): number {
  switch (input.fn) {
    case 'buy':
      return input.value
    case 'mobBuy':
      return input.value < 10 ? 10 : input.value
    case 'sell': {
      const half = Math.floor(input.value / 2)
      return half > 100000 ? 100000 : half
    }
    case 'repair':
      return Math.floor(input.value / 4)
  }
}

/** fixture 한 case의 형태. input은 SUT 함수가 받는 정가 + 디스패치 키다. */
type PriceCase = { input: PriceInput; expected: number; note?: string }

/** expected를 채우기 전의 case 초안. */
type PriceCaseDraft = Omit<PriceCase, 'expected'>

/**
 * 골든 케이스 12개를 구성한다. expected는 생성기 정상 경로대로 `referencePrice`로 채운다.
 * (테스트 측 Layer B 앵커는 이와 독립적으로 손 계산 하드 리터럴을 사용해 tautology를 차단한다.)
 *
 * 경계 커버리지: value<40(39)·판매 상한(200000 경계·250000 초과)·몹구매 하한(5·0)·중간값(100).
 */
export function buildCases(): PriceCase[] {
  const inputs: PriceCaseDraft[] = [
    { input: { fn: 'buy', value: 39 }, note: 'buy value<40 (정가)' },
    { input: { fn: 'mobBuy', value: 39 }, note: 'mobBuy 하한 위' },
    { input: { fn: 'sell', value: 39 }, note: 'sell 홀수 truncation (19.5→19)' },
    { input: { fn: 'repair', value: 39 }, note: 'repair truncation (9.75→9)' },
    { input: { fn: 'buy', value: 100 }, note: 'buy 중간값' },
    { input: { fn: 'mobBuy', value: 100 }, note: 'mobBuy 중간값' },
    { input: { fn: 'sell', value: 100 }, note: 'sell 중간값 (50%)' },
    { input: { fn: 'repair', value: 100 }, note: 'repair 중간값 (25%)' },
    { input: { fn: 'mobBuy', value: 5 }, note: 'mobBuy floor 함정 (5→10)' },
    { input: { fn: 'mobBuy', value: 0 }, note: 'mobBuy floor 함정 (0→10)' },
    { input: { fn: 'sell', value: 200000 }, note: 'sell 상한 정확히 (100000)' },
    { input: { fn: 'sell', value: 250000 }, note: 'sell 상한 초과 clamp (125000→100000)' },
  ]

  return inputs.map((c) => ({ ...c, expected: referencePrice(c.input) }))
}

/**
 * 케이스를 골든 fixture로 감싼다. `generatedAt`은 주입 clock으로 스탬프해 결정적으로 만든다.
 */
export function buildFixture(clock: () => Date): GoldenFixture<PriceInput, number> {
  return makeManualFixture(
    'price',
    'command7.c:169/258, command8.c:249, command10.c:573 (A8 §8 가격 배수)',
    buildCases(),
    clock,
  )
}
