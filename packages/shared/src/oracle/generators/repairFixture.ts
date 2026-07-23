import { bonusOf } from '../../stats/index.js'
import type { GoldenFixture } from '../types.js'
import { makeManualFixture, writeFixtureFile } from './fixtureIo.js'

// 재생성 명령이 `import { buildFixture, writeFixtureFile }`로 소비하므로 writer를 re-export한다.
export { writeFixtureFile }

/**
 * 아이템 수리(repair) 골든 fixture 생성기 — manual oracle의 독립 참조 구현(A8 §8 RREPAI, command8.c).
 *
 * 원본 `command8.c` repair의 핵심 역학(piety 보정 실패 굴림 + 성공 시 내구도 복원)을 참조
 * 구현(`referenceRepair`)으로 옮기고, 손 계산으로 확정한 8개 케이스를 fixture로 감싸
 * `fixtures/repair.json`에 기록한다. 수리비 산술 정본은 shared `economy/priceConfig.ts`의
 * `repairCost`(SUT)에, 실패 굴림·내구도 복원 정본은 server `shopService.repair`(SUT)에 둔다.
 *
 * ## 오라클 역학 (command8.c repair)
 *   cost  = value / 4                                       // trunc(value/4)
 *   gold -= cost                                            // 선차감
 *   broke = mrand(1,100) + bonus[piety]                     // bonusOf(piety)
 *   실패  = (broke <= 15 && shotscur < 1) || (broke <= 5 && shotscur > 0)
 *           → gold += cost (환불, net 0) + free_obj (파괴)
 *   성공  = shotscur = (shotsmax * mrand(5,9)) / 10          // 곱 위에서 정수 나눗셈
 *
 * ## anti-tautology: SUT와 독립 표현
 * SUT(`repairCost`·`repair`)는 `PRICE_CONFIG.repairDivisor`를 판독하고 `Math.trunc`로 절삭한다.
 * 이 참조는 **인라인 리터럴**(`4`·`10`·임계값 `15`/`5`)을 직접 쓰고 절삭을 `Math.floor`로 표현한다
 * (value·shotsmax 비음수라 값 동일, 표현만 다름). 참조는 SUT(`repairCost`·`repair`)를 import·호출하지
 * 않는다. `bonusOf`는 shared의 lookup DATA(class_stats 류)이므로 소비해도 tautology가 아니다 —
 * anti-tautology는 공식 구조 층위에서 성립한다.
 *
 * ## 재생성 (수동 트리거)
 * `expected`·`generatedAt`은 체크인 후 frozen이며 회귀 테스트 중 자동 재생성은 없다. bare `node`는
 * 상대 import의 `.js`→`.ts`를 해석하지 못하므로 TS-aware 러너로 재생성한다. 임시 테스트를 vitest로
 * 1회 실행하고 제거한다:
 *
 * ```
 * cd packages/shared
 * cat > src/oracle/generators/__regen.test.ts <<'EOF'
 * import { it } from 'vitest'
 * import { buildFixture, writeFixtureFile } from './repairFixture.js'
 * it('regen', () => {
 *   writeFixtureFile('./src/oracle/fixtures/repair.json',
 *     buildFixture(() => new Date('2026-07-13T00:00:00.000Z')))
 * })
 * EOF
 * pnpm exec vitest run src/oracle/generators/__regen.test.ts
 * rm src/oracle/generators/__regen.test.ts
 * ```
 */

/**
 * fixture 한 case의 input 형태 — repair 역학이 판독하는 좁은 필드 + 결정적 굴림 값.
 * `brokeRoll`은 `mrand(1,100)`의 반환값(bonus 적용 전 raw), `durabilityRoll`은 `mrand(5,9)`의
 * 반환값을 고정한다. 실패 케이스에서는 `durabilityRoll`이 소비되지 않는다(성공 시에만 굴림).
 */
export type RepairInput = {
  value: number
  shotscur: number
  shotsmax: number
  piety: number
  brokeRoll: number
  durabilityRoll: number
}

/** fixture 한 case의 expected 형태 — 파괴 여부·수리비·복원된 내구도(파괴 시 null). */
export type RepairExpected = { broken: boolean; cost: number; newShotscur: number | null }

/**
 * 아이템 수리 참조 구현 — command8.c repair 역학을 인라인 리터럴로 옮긴다.
 *
 * SUT(`repairCost`·`repair`)와 표현을 분리한다: 여기선 `PRICE_CONFIG`를 참조하지 않고 제수 `4`·`10`을
 * 인라인 리터럴로 박고, 정수 절삭을 `Math.floor`로 표현한다(SUT는 `Math.trunc`). 실패 조건과 내구도
 * 복원 곱셈 그룹핑(`shotsmax * roll / 10`, 곱 위에서 절삭)은 오라클과 동일 구조여야 정확한 expected가
 * 나오므로 구조는 유지하되 산술 표현만 독립시킨다. `bonusOf`는 shared lookup DATA라 소비해도 무방하다.
 */
export function referenceRepair(input: RepairInput): RepairExpected {
  const cost = Math.floor(input.value / 4)
  const broke = input.brokeRoll + bonusOf(input.piety)
  const broken = (broke <= 15 && input.shotscur < 1) || (broke <= 5 && input.shotscur > 0)
  if (broken) return { broken: true, cost, newShotscur: null }
  const newShotscur = Math.floor((input.shotsmax * input.durabilityRoll) / 10)
  return { broken: false, cost, newShotscur }
}

/** fixture 한 case의 형태. input은 repair 역학이 받는 좁은 필드 + 두 굴림 값이다. */
type RepairCase = { input: RepairInput; expected: RepairExpected; note?: string }

/** expected를 채우기 전의 case 초안. */
type RepairCaseDraft = Omit<RepairCase, 'expected'>

/**
 * 판독하지 않는 필드에 안전한 기본값을 채워 완전한 RepairInput을 만든다. 각 케이스는 검증 대상
 * 필드만 overrides로 지정한다. 기본은 value=100(cost 25)·shotsmax=80·piety=10(bonusOf=0)·
 * brokeRoll=50(임계값 초과 → 성공)·durabilityRoll=5.
 */
function repairInput(overrides: Partial<RepairInput>): RepairInput {
  return {
    value: 100,
    shotscur: 0,
    shotsmax: 80,
    piety: 10,
    brokeRoll: 50,
    durabilityRoll: 5,
    ...overrides,
  }
}

/**
 * 골든 케이스 8개를 구성한다. expected는 생성기 정상 경로대로 `referenceRepair`로 채운다.
 * (테스트 측 Layer B 앵커는 이와 독립적으로 손 계산 하드 리터럴을 사용해 tautology를 차단한다.)
 *
 * 실패 임계값(broke≤15 & shotscur<1, broke≤5 & shotscur>0)의 경계 상하, bonusOf(piety) 통합
 * (piety=0 → -4), 내구도 곱셈 트렁케이트 트랩(85*7/10=59.5→59), 수리비 편차(value=39→9)를 커버한다.
 */
export function buildCases(): RepairCase[] {
  const inputs: RepairCaseDraft[] = [
    {
      input: repairInput({ piety: 10, shotscur: 0, brokeRoll: 15 }),
      note: 'fail: piety=10 broke=15, shotscur<1 (broke≤15) → 파괴',
    },
    {
      input: repairInput({ piety: 10, shotscur: 0, brokeRoll: 16, durabilityRoll: 5 }),
      note: 'success 경계 위: broke=16(>15) → 복원 floor(80*5/10)=40',
    },
    {
      input: repairInput({ piety: 10, shotscur: 1, brokeRoll: 5 }),
      note: 'fail: piety=10 broke=5, shotscur>0 (broke≤5) → 파괴',
    },
    {
      input: repairInput({ piety: 10, shotscur: 1, brokeRoll: 6, durabilityRoll: 9 }),
      note: 'success 경계 위: broke=6(>5), shotscur=1 → 복원 floor(80*9/10)=72',
    },
    {
      input: repairInput({ piety: 0, shotscur: 0, brokeRoll: 19 }),
      note: 'fail: bonusOf(0)=-4 → broke=15 → 파괴(bonusOf 통합 증명)',
    },
    {
      input: repairInput({ piety: 0, shotscur: 0, brokeRoll: 20, durabilityRoll: 5 }),
      note: 'success: bonusOf(0)=-4 → broke=16 → 복원 floor(80*5/10)=40',
    },
    {
      input: repairInput({ shotsmax: 85, durabilityRoll: 7, shotscur: 1 }),
      note: 'trunc 트랩: floor(85*7/10)=floor(59.5)=59 (85*floor(7/10)=0 아님)',
    },
    {
      input: repairInput({ value: 39, durabilityRoll: 5, shotscur: 1 }),
      note: 'cost 편차: value=39 → cost floor(39/4)=9, 복원 floor(80*5/10)=40',
    },
  ]

  return inputs.map((c) => ({ ...c, expected: referenceRepair(c.input) }))
}

/**
 * 케이스를 골든 fixture로 감싼다. `generatedAt`은 주입 clock으로 스탬프해 결정적으로 만든다.
 */
export function buildFixture(clock: () => Date): GoldenFixture<RepairInput, RepairExpected> {
  return makeManualFixture(
    'repair',
    'command8.c repair (A8 §8 RREPAI 아이템 수리·실패 파괴·내구도 복원)',
    buildCases(),
    clock,
  )
}
