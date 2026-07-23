import type { GoldenFixture } from '../types.js'
import { makeManualFixture, writeFixtureFile } from './fixtureIo.js'

// 재생성 명령이 `import { buildFixture, writeFixtureFile }`로 소비하므로 writer를 re-export한다.
export { writeFixtureFile }

/**
 * 전당포 판매(pawn/sell) 골든 fixture 생성기 — manual oracle의 독립 참조 구현(A8 §8, command7.c sell).
 *
 * 원본 `command7.c`의 판매 게이트(거부 매트릭스 + 1/250 이중 지급)를 참조 구현(`referencePawn`)으로
 * 옮기고, 손 계산으로 확정한 13개 케이스를 fixture로 감싸 `fixtures/pawn.json`에 기록한다. 판매가
 * 산술 정본은 런타임 `economy/priceConfig.ts`의 `sellPrice`(SUT)에, 거부·이중지급 게이트 정본은
 * 런타임 `server`의 `shopService.sell`(SUT)에 둔다.
 *
 * ## 오라클 거부 순서 (command7.c sell)
 *   1. gold < 20                              → 'low-value'   (gold = min(trunc(value/2),100000))
 *   2. poorquality                            → 'low-quality'
 *        (type <= MISSILE(4) || type == ARMOR(5)) && shotscur <= trunc(shotsmax/8)  // 마모 장비·투척
 *        (type == WAND(8) || type == KEY(11)) && shotscur < 1                       // 방전 충전물
 *   3. ONEWEV (개인 귀속)                       → 'bound-item'
 *   4. first_obj (비빈 컨테이너)                 → 'non-empty-container'
 *   5. type == SCROLL(7) || type == POTION(6)  → 'unsellable-type'
 * 이후 `((time(0)+mrand(1,100))%250)==9`면 이중 지급. A8 §10-e에 따라 time(0) 벽시계 의존을 버리고
 * 단일 `rng(1,250)===9` 굴림으로 대체한다 — 확률 1/250(콘텐츠)은 보존, `===9`는 오라클 상수를 반향한다.
 *
 * ## anti-tautology: SUT와 독립 표현
 * SUT(`priceConfig.sellPrice`)는 `PRICE_CONFIG` 상수를 판독하고 `Math.trunc`로 절삭한다. 이 참조는
 * **인라인 리터럴**(`2`·`100000`·타입 상수)을 직접 쓰고 절삭은 `Math.floor`로 표현한다(value 비음수라
 * 값 동일, 표현만 다름). 참조는 SUT(sellPrice·sell)를 import·호출하지 않는다.
 *
 * ## 재생성 (수동 트리거)
 * `expected`·`generatedAt`은 체크인 후 frozen이며, 회귀 테스트 중 자동 재생성은 없다. bare `node`는
 * 상대 import의 `.js`→`.ts`를 해석하지 못하므로 TS-aware 러너로 재생성한다. 임시 테스트를 vitest로
 * 1회 실행하고 제거한다:
 *
 * ```
 * cd packages/shared
 * cat > src/oracle/generators/__regen.test.ts <<'EOF'
 * import { it } from 'vitest'
 * import { buildFixture, writeFixtureFile } from './pawnFixture.js'
 * it('regen', () => {
 *   writeFixtureFile('./src/oracle/fixtures/pawn.json',
 *     buildFixture(() => new Date('2026-07-13T00:00:00.000Z')))
 * })
 * EOF
 * pnpm exec vitest run src/oracle/generators/__regen.test.ts
 * rm src/oracle/generators/__regen.test.ts
 * ```
 */

/**
 * fixture 한 case의 input 형태 — 판매 게이트가 판독하는 좁은 필드 + 결정적 1/250 굴림 값.
 * `luckyRoll`은 `rng(1,250)`의 반환값을 고정한다(9면 이중 지급). 거부 케이스에서는 소비되지 않는다.
 */
export type PawnInput = {
  value: number
  type: number
  shotscur: number
  shotsmax: number
  onewev: boolean
  hasContents: boolean
  luckyRoll: number
}

/** fixture 한 case의 expected 형태 — 거부 사유(통과 시 null)와 최종 지급액(거부 시 0). */
export type PawnExpected = { rejectReason: string | null; payout: number }

/**
 * 전당포 판매 참조 구현 — command7.c sell 게이트를 인라인 리터럴로 옮긴다.
 *
 * SUT(`sellPrice`·`sell`)와 표현을 분리한다: 여기선 `PRICE_CONFIG`를 참조하지 않고 상수를 인라인
 * 리터럴로 박고, 정수 절삭을 `Math.floor`로 표현한다(SUT는 `Math.trunc`). 거부 순서는 오라클과
 * 동일해야 정확한 expected가 나오므로 cascade 순서는 유지하되 산술 표현만 독립시킨다.
 * 이중 지급은 오라클의 pay-twice(`+= sell`)를 그대로 표현한다(`sell * 2`가 아니라 `sell + sell`).
 */
export function referencePawn(input: PawnInput): PawnExpected {
  const half = Math.floor(input.value / 2)
  const sell = half > 100000 ? 100000 : half
  const lowGrade =
    (input.type <= 4 || input.type === 5) && input.shotscur <= Math.floor(input.shotsmax / 8)
  const chargeGone = (input.type === 8 || input.type === 11) && input.shotscur < 1
  const poor = lowGrade || chargeGone

  if (sell < 20) return { rejectReason: 'low-value', payout: 0 }
  if (poor) return { rejectReason: 'low-quality', payout: 0 }
  if (input.onewev) return { rejectReason: 'bound-item', payout: 0 }
  if (input.hasContents) return { rejectReason: 'non-empty-container', payout: 0 }
  if (input.type === 7 || input.type === 6) return { rejectReason: 'unsellable-type', payout: 0 }

  const finalPayout = input.luckyRoll === 9 ? sell + sell : sell
  return { rejectReason: null, payout: finalPayout }
}

/** fixture 한 case의 형태. input은 판매 게이트가 받는 좁은 필드 + luckyRoll이다. */
type PawnCase = { input: PawnInput; expected: PawnExpected; note?: string }

/** expected를 채우기 전의 case 초안. */
type PawnCaseDraft = Omit<PawnCase, 'expected'>

/**
 * 판독하지 않는 필드에 안전한 기본값을 채워 완전한 PawnInput을 만든다. 각 케이스는 검증 대상
 * 필드만 overrides로 지정한다. 기본은 type=13(MISC, 판매가능)·비귀속·빈용기·luckyRoll=1(비럭키).
 */
function pawn(overrides: Partial<PawnInput>): PawnInput {
  return {
    value: 100,
    type: 13,
    shotscur: 0,
    shotsmax: 0,
    onewev: false,
    hasContents: false,
    luckyRoll: 1,
    ...overrides,
  }
}

/**
 * 골든 케이스 13개를 구성한다. expected는 생성기 정상 경로대로 `referencePawn`으로 채운다.
 * (테스트 측 Layer B 앵커는 이와 독립적으로 손 계산 하드 리터럴을 사용해 tautology를 차단한다.)
 *
 * 거부 매트릭스(low-value·low-quality 무기/완드·bound·container·scroll·potion) + 경계(sellable)
 * + 정상/이중 지급 + 상한 clamp를 커버한다.
 */
export function buildCases(): PawnCase[] {
  const inputs: PawnCaseDraft[] = [
    { input: pawn({ value: 39 }), note: 'low-value: payout 19<20 → 거부' },
    { input: pawn({ value: 40, luckyRoll: 1 }), note: 'low-value 경계 위: payout 20 → 판매 성공' },
    {
      input: pawn({ type: 0, shotsmax: 80, shotscur: 10 }),
      note: 'low-quality 무기: shotscur 10 <= trunc(80/8)=10 → 거부',
    },
    {
      input: pawn({ type: 0, shotsmax: 80, shotscur: 11, luckyRoll: 1 }),
      note: 'low-quality 경계 위: shotscur 11 > 10 → 판매 성공',
    },
    { input: pawn({ type: 8, shotscur: 0 }), note: 'low-quality 완드: shotscur 0 < 1 → 거부' },
    {
      input: pawn({ type: 8, shotscur: 1, luckyRoll: 1 }),
      note: 'low-quality 경계 위: 완드 shotscur 1 → 판매 성공',
    },
    { input: pawn({ onewev: true }), note: 'bound: ONEWEV(개인 귀속) → 거부' },
    { input: pawn({ hasContents: true }), note: 'container: 비빈 컨테이너(first_obj) → 거부' },
    { input: pawn({ type: 7 }), note: 'unsellable: SCROLL(7) → 거부' },
    { input: pawn({ type: 6 }), note: 'unsellable: POTION(6) → 거부' },
    { input: pawn({ value: 100, luckyRoll: 1 }), note: '정상 지급: payout 50, 비럭키' },
    {
      input: pawn({ value: 100, luckyRoll: 9 }),
      note: '이중 지급: luckyRoll===9 → pay-twice 100 (=2*50)',
    },
    {
      input: pawn({ value: 250000, luckyRoll: 1 }),
      note: '상한 clamp: trunc(125000) → 100000',
    },
  ]

  return inputs.map((c) => ({ ...c, expected: referencePawn(c.input) }))
}

/**
 * 케이스를 골든 fixture로 감싼다. `generatedAt`은 주입 clock으로 스탬프해 결정적으로 만든다.
 */
export function buildFixture(clock: () => Date): GoldenFixture<PawnInput, PawnExpected> {
  return makeManualFixture('pawn', 'command7.c sell (A8 §8 전당포 판매 거부·이중지급)', buildCases(), clock)
}
