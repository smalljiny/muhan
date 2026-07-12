import { writeFileSync } from 'node:fs'
import type { GoldenFixture } from '../types.js'

/**
 * compute_ac(방어도) 골든 fixture 생성기 — manual oracle.
 *
 * 원본 `player.c:971`의 방어도 공식을 참조 구현(`referenceComputeAc`)으로 옮기고,
 * 손 계산으로 확정한 7개 케이스를 fixture로 감싸 `fixtures/compute_ac.json`에 기록한다.
 * oracle 출처는 `player.c:971`(분석 노트 `a5-combat.md:184`).
 *
 * ## 재생성 (수동 트리거)
 * `expected`·`generatedAt`은 체크인 후 frozen이며, 회귀 테스트 중 자동 재생성은 없다.
 * fixture를 다시 스탬프하려면 사람이 아래 명령을 직접 실행한다(고정 clock으로 결정적):
 *
 * ```
 * cd packages/shared
 * node --input-type=module -e "import { buildFixture, writeFixtureFile } from './src/oracle/generators/computeAcFixture.ts'; writeFixtureFile('./src/oracle/fixtures/compute_ac.json', buildFixture(() => new Date('2026-07-13T00:00:00.000Z')))"
 * ```
 *
 * ## referenceComputeAc의 discrimination 역할
 * 이 참조 구현은 Story 4의 SUT `computeAc`와 **독립 표현**으로 작성한다(여기선 for-루프
 * 누적, SUT는 다른 표현). 두 구현이 우연히 동일 문장이 되면 하네스의 판별력이 약해진다.
 */

/** compute_ac 입력. Story 4의 SUT `computeAc`도 이 타입을 공유한다. */
export type ComputeAcInput = {
  /** raw 민첩(구현에서 MIN(dex,63)). */
  dexterity: number
  /** 착용 장비 armor 합(부호 있음 — 저주 장비면 음수 가능). */
  equipArmor: number
  /** PPROTE(보호마법) 플래그. */
  protection: boolean
}

/**
 * 민첩 보너스 테이블 `bonus[64]`(원본 `player.c` 전역). 정확히 64개 원소.
 * `ac -= 5 * bonus[MIN(dexterity,63)]` — 값이 클수록 방어도가 낮아진다(우수).
 */
export const bonus: readonly number[] = [
  -4, -4, -4, -3, -3, -2, -2, -1, // 0-7
  -1, -1, 0, 0, 0, 0, 1, 1, // 8-15
  1, 2, 2, 2, 3, 3, 3, 3, // 16-23
  4, 4, 4, 4, 4, 5, 5, 5, // 24-31
  5, 5, 5, 6, 6, 6, 6, 6, // 32-39
  6, 6, 6, 6, 7, 7, 7, 7, // 40-47
  7, 7, 7, 7, 7, 7, 7, 7, // 48-55
  7, 7, 7, 7, 7, 7, 7, 7, // 56-63
]

/**
 * compute_ac 참조 구현 — `player.c:971` 정공식을 for-루프 누적 스타일로 옮긴다.
 *
 * `Math.max(0, ...)` 하한 방어는 게임 입력이 비음수라는 전제의 안전망이다 —
 * dexterity가 음수여도 bonus 인덱스가 음수가 되지 않도록 막는다.
 */
export function referenceComputeAc(input: ComputeAcInput): number {
  // 누적 단계를 명시적으로 분해한다(SUT와 표현을 분리해 판별력 유지).
  const steps: number[] = []
  steps.push(100)

  const dexIndex = Math.max(0, Math.min(input.dexterity, 63))
  // dexIndex는 항상 [0,63]이라 bonus[dexIndex]는 정의됨 — `?? 0`은 도달 불가한 안전망이다.
  steps.push(-5 * (bonus[dexIndex] ?? 0))

  steps.push(-input.equipArmor)

  if (input.protection) {
    steps.push(-10)
  }

  let ac = 0
  for (const step of steps) {
    ac += step
  }

  // clamp [-127, 127].
  return Math.max(-127, Math.min(127, ac))
}

/** fixture 한 case의 형태. */
type ComputeAcCase = { input: ComputeAcInput; expected: number; note?: string }

/** expected를 채우기 전의 case 초안(input·note만). */
type ComputeAcCaseDraft = Omit<ComputeAcCase, 'expected'>

/**
 * 골든 케이스 7개를 구성한다. expected는 생성기 정상 경로대로 `referenceComputeAc`로 채운다.
 * (테스트 측 앵커는 이와 독립적으로 손 계산 하드 리터럴을 사용해 tautology를 차단한다.)
 */
export function buildCases(): ComputeAcCase[] {
  const inputs: ComputeAcCaseDraft[] = [
    { input: { dexterity: 10, equipArmor: 0, protection: false } },
    { input: { dexterity: 20, equipArmor: 20, protection: true } },
    { input: { dexterity: 63, equipArmor: 0, protection: false } },
    { input: { dexterity: 0, equipArmor: 0, protection: false }, note: '음 bonus' },
    { input: { dexterity: 63, equipArmor: 300, protection: true }, note: 'clamp 하한 경계' },
    {
      input: { dexterity: 0, equipArmor: -20, protection: false },
      note: 'clamp 상한 경계·게임 현실성 미검증',
    },
    { input: { dexterity: 70, equipArmor: 0, protection: false }, note: 'MIN cap 검증' },
  ]

  return inputs.map((c) => ({ ...c, expected: referenceComputeAc(c.input) }))
}

/**
 * 케이스를 골든 fixture로 감싼다. `generatedAt`은 주입 clock으로 스탬프해 결정적으로 만든다.
 */
export function buildFixture(clock: () => Date): GoldenFixture<ComputeAcInput, number> {
  return {
    fn: 'compute_ac',
    oracle: {
      method: 'manual',
      source: 'player.c:971 (A5 §6 a5-combat.md:184)',
      generatedAt: clock().toISOString(),
      seed: null,
    },
    cases: buildCases(),
  }
}

/** fixture를 2-space pretty JSON으로 파일에 기록한다. */
export function writeFixtureFile(
  path: string,
  fixture: GoldenFixture<ComputeAcInput, number>,
): void {
  writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8')
}
