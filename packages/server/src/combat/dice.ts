/**
 * dice/mdice 프리미티브 — 무한 전투·마법·경제 피해 굴림의 단일 출처(오라클 misc.c:454, mtype.h:588).
 *
 * 오라클 공식:
 *   dice(n,s,p) = p + Σⁿ mrand(1,s)   — p(pdice base)에 s면체 주사위 n개의 합을 더한다.
 *   mdice(a)    = dice(a.ndice, a.sdice, a.pdice)
 *   mrand(a,b)  = [a,b] 양끝 포함(inclusive) 정수 균등.
 *
 * RNG seam(CombatRng)은 범용 `(min,max)=>number`(mrand 관례)로 정의해 dice의 mrand(1,s)뿐 아니라
 * 크리티컬 배수 mrand(3,6)·명중 굴림 mrand(1,30)/(1,20) 등 전투 전역 굴림에 재사용된다. `rng`는 필수
 * 파라미터다 — 기본값을 두지 않아 프로덕션 호출이 결정적 최소 굴림으로 조용히 축소되는 사고를
 * 방지한다(결정적 stub은 test-only `dice.testutil.ts`가 소유). 실 seeded PRNG 배선은 후속 D1 팩토리 소관.
 */

/**
 * mrand 관례 굴림 seam — `[min, max]` 양끝 포함 정수를 반환하는 계약이다. 정수 반환 계약은
 * `dice`가 어서션으로 강제한다(비정수면 피해 차감이 float 드리프트를 일으키므로).
 */
export type CombatRng = (min: number, max: number) => number

/** ndice/sdice/pdice 3필드를 담는 구조적 주사위 스펙(mdice 입력). CreatureInstance 의존 없음. */
export interface DiceSpec {
  readonly ndice: number
  readonly sdice: number
  readonly pdice: number
}

/**
 * dice(n,s,p,rng) = p + Σⁿ rng(1,s). rng를 정확히 (1, s)로 n번 호출해 합산한다.
 * n<=0이면 rng를 호출하지 않고 p를 그대로 반환한다(빈 합).
 */
export function dice(n: number, s: number, p: number, rng: CombatRng): number {
  let total = p
  for (let i = 0; i < n; i += 1) {
    const roll = rng(1, s)
    if (!Number.isInteger(roll)) {
      throw new Error(`CombatRng는 정수를 반환해야 한다(정수 계약 위반): rng(1, ${s}) => ${roll}`)
    }
    total += roll
  }
  return total
}

/** mdice(entity, rng) = dice(entity.ndice, entity.sdice, entity.pdice, rng). */
export function mdice(entity: DiceSpec, rng: CombatRng): number {
  return dice(entity.ndice, entity.sdice, entity.pdice, rng)
}

/**
 * 프로덕션 `CombatRng` 구현 — `[min, max]` 양끝 포함 균등 정수(오라클 `mrand(a,b)` 관례).
 *
 * 이 저장소에 프로덕션 **난수** 굴림 구현이 0건이라(결정적 stub `dice.testutil.ts`는 테스트 전용) 라이브
 * 배선이 주입할 것이 없었다. 그 빈자리를 채우는 최소 구현이며, 전투 모듈은 이것을 **직접 부르지
 * 않는다** — 순수 함수들은 여전히 `rng` 인자로만 굴림을 받고, 이 구현은 배선 계층이 주입 seam에
 * 꽂아 넣는 값이다(모듈 순수성 유지).
 *
 * `Math.floor(Math.random() * (max - min + 1)) + min`은 `Math.random()`의 값역이 `[0, 1)`이라
 * 양끝을 포함한다. `max < min`이면 폭이 0 이하가 되어 `min`을 반환한다(굴림 없는 퇴화 구간).
 *
 * 재현 가능한 seeded PRNG는 이 seam을 그대로 대체하면 된다 — 소비자는 타입만 보므로 교체 비용이
 * 주입 지점 한 곳이다.
 */
export const defaultCombatRng: CombatRng = (min: number, max: number) => {
  const width = max - min + 1
  if (width <= 1) return min
  return Math.floor(Math.random() * width) + min
}
