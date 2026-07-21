import type { CombatRng } from './dice.js'

/**
 * dice/mdice 결정적 CombatRng stub — test-only.
 *
 * 파일명이 `.testutil.ts`라 server build(tsconfig.build.json)·coverage(vitest.config.ts) 양쪽 glob에서
 * 자동 제외된다(테스트 인프라, 프로덕션 코드 아님). 실전 굴림을 최소화하는 min-반환 stub을 프로덕션
 * 기본값으로 export하지 않기 위해 여기 격리한다(advisor #5).
 *
 * args-sensitive stub 원칙: 상수(`()=>1`)가 아니라 *전달된 인자*를 반환한다. 이로써 property 테스트가
 * mrand의 호출 인자 `(1, s)`를 off-by-one까지 고정한다 — maxRollRng는 2nd 인자가 s임을, minRollRng는
 * 1st 인자가 1임을 pin한다.
 */

/** 항상 상한(max 인자)을 반환 — mrand(1,s) 상한. dice === p + n*s를 만든다. */
export const maxRollRng: CombatRng = (_min: number, max: number) => max

/** 항상 하한(min 인자)을 반환 — mrand(1,s) 하한. dice === p + n*1을 만든다. */
export const minRollRng: CombatRng = (min: number) => min

/**
 * 미리 정한 값 시퀀스를 순서대로 반환하는 결정적 rng. 굴림 순서·개수 검증용. 시퀀스를 초과 호출하면
 * throw해 예상보다 많은 굴림(호출 수 오류)을 즉시 드러낸다.
 */
export function seqRng(values: readonly number[]): CombatRng {
  let i = 0
  return () => {
    const v = values[i]
    if (v === undefined) {
      throw new Error(`seqRng 시퀀스 소진: ${values.length}개 초과 호출`)
    }
    i += 1
    return v
  }
}
