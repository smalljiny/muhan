import type { ObjectInstance } from 'shared'
import { POTION, SCROLL, WAND } from './taxonomy.js'
import { evaluateGate } from '../magic/gate.js'
import { NOT_IMPLEMENTED, type SpellDispatch } from '../magic/dispatch.js'
import type { Caster } from '../magic/caster.js'

/**
 * 소비 아이템 magic 배달 seam(magic1.c drink/readscroll/zap · #86).
 *
 * POTION(drink)·SCROLL(readscroll)·WAND(zap)는 담긴 주문(splno=magicpower-1)을 how≠CAST로
 * magic dispatch에 배달할 수 있는지 **분류만** 한다.
 *
 * ## gated=false — 시전 자격 게이트 우회
 * evaluateGate를 gated=false로 호출한다. magic1.c의 마나(mpcur<mp)·knowledge(!S_ISSET) 게이트는
 * how==CAST일 때만 발화하므로, 소비 경로(how≠CAST)는 이를 우회한다 — 콘텐츠(아이템 효과)를
 * 규칙(시전 자격)으로 막지 않는다. applyCastGate가 아니라 evaluateGate를 쓴다(마나 write-through 없음).
 *
 * ## effect 본체 재구현 없음 — 분류만
 * dispatch.resolve로 주문을 분류만 하고 실행하지 않는다. 핸들러 형태(H)는 dispatch.ts에서
 * 제네릭 미확정이라 호출할 수 없다(S5 offensiveSpell 등록 후 command router가 호출).
 *
 * ## shotscur 감소는 seam이 하지 않는다 — 오라클 성공 결합(§5 배선 유예)
 * 오라클 drink/readscroll/zap은 spell fn 반환값 n을 관찰해 **`if(n)`(효과 성공)일 때만** shotscur를
 * 감소한다(magic1.c drink:647-655·readscroll:476-481·zap:802-806). 이 순수 seam은 핸들러를
 * 실행하지 못해 성공 n을 관찰할 수 없으므로 감소를 결정할 수 없다 — charge 감소·객체 파괴는
 * effect 실행 후 성공을 관찰하는 배선 계층 소관이다(§5 Non-goal). delivered는 "배달 가능"만 알리고
 * 입력 인스턴스를 변형하지 않는다.
 */

/** 소비 컨텍스트 — 어느 소비 명령(drink/readscroll/zap) 경로인지. */
export type ConsumeContext = 'potion' | 'scroll' | 'wand'

/**
 * 소비 배달 결과(exhaustive union). 각 케이스는 정확히 한 경로에 안착한다.
 * 어떤 케이스도 shotscur를 감소하지 않는다 — 감소는 effect 성공(오라클 `if(n)`)에 결합돼
 * 배선 계층 소관이다(모듈 docstring 참조). 이 seam은 입력 인스턴스를 변형하지 않는다.
 */
export type ConsumeOutcome =
  // 소비 대상 타입이 아님(type ∉ {POTION,SCROLL,WAND}).
  | { kind: 'noop' }
  // 남은 충전 없음(shotscur < 1) — 오라클 drink shotscur<1 pre-guard.
  | { kind: 'depleted' }
  // 담긴 주문 없음(magicpower < 1 → spellNo=-1).
  | { kind: 'no-spell' }
  // 비-offensive 주문 → NOT_IMPLEMENTED(#85 유예).
  | { kind: 'deferred'; spellNo: number; context: ConsumeContext }
  // offensive 미등록 주문 → undefined(핸들러는 magic S5에서 등록).
  | { kind: 'unresolved'; spellNo: number; context: ConsumeContext }
  // 핸들러 resolve 성공 → 배달 가능. 배선 계층이 핸들러를 실행하고 성공(`if(n)`) 시 shotscur를 감소한다.
  // (gate는 gated=false로 무조건 우회하므로 delivered 도달은 resolve 결과만으로 결정된다.)
  | { kind: 'delivered'; spellNo: number; context: ConsumeContext }

/** deliverConsumable 입력 — 소비 대상 타입·주문력·인스턴스·시전자·디스패처. */
export interface DeliverConsumableParams {
  readonly type: number
  readonly magicpower: number
  readonly instance: ObjectInstance
  readonly caster: Caster
  readonly dispatch: SpellDispatch<unknown>
}

/** 소비 타입 → context 라우팅. POTION/SCROLL/WAND만 대응하고 그 외는 null. */
function contextOf(type: number): ConsumeContext | null {
  if (type === POTION) return 'potion'
  if (type === SCROLL) return 'scroll'
  if (type === WAND) return 'wand'
  return null
}

/**
 * 소비 아이템을 magic dispatch에 배달한다. 첫 매칭에서 반환한다:
 * context 라우팅 → shotscur 가드 → magicpower 특수처리(resolve 이전) → gate(우회) → resolve 분기.
 */
export function deliverConsumable(params: DeliverConsumableParams): ConsumeOutcome {
  const { type, magicpower, instance, caster, dispatch } = params

  // ① context 라우팅 — 소비 대상 타입이 아니면 noop.
  const context = contextOf(type)
  if (context === null) return { kind: 'noop' }

  // ② shotscur 가드 — 남은 충전이 없으면 배달 전 차단(오라클 drink shotscur<1 pre-guard).
  if (instance.shotscur < 1) return { kind: 'depleted' }

  // ③ magicpower 특수처리(resolve 이전!) — magicpower<1이면 spellNo=-1이 되어
  //    offensive-미등록(undefined)과 구분 불가해진다. resolve에 넘기기 전에 걸러낸다.
  if (magicpower < 1) return { kind: 'no-spell' }

  // ④ splno = magicpower - 1(오라클 drink/readscroll/zap).
  const spellNo = magicpower - 1

  // ⑤ gate(순수, 마나 미소비) — gated=false라 마나·클래스·knowledge를 전부 우회(항상 PASS).
  //    소비 경로(how≠CAST)는 시전 자격을 묻지 않는다. 반환값을 의도적으로 버린다 —
  //    이 호출은 "consult-but-bypass" seam 마커이며, 향후 소비 게이팅이 필요해질 때의 배선 지점이다.
  //    applyCastGate가 아닌 evaluateGate를 써 마나 write-through를 피한다.
  evaluateGate(caster, { manaCost: 0, spellNo }, false)

  // ⑥ resolve 분기 — 분류만, effect 실행 안 함.
  const resolved = dispatch.resolve(spellNo)
  if (resolved === NOT_IMPLEMENTED) return { kind: 'deferred', spellNo, context }
  if (resolved === undefined) return { kind: 'unresolved', spellNo, context }

  // 핸들러 resolve 성공 → 배달 가능. shotscur 감소는 배선 계층이 effect 성공(`if(n)`) 시 수행한다.
  // 이 seam은 입력 인스턴스를 변형하지 않는다(오라클 성공 결합 — 모듈 docstring 참조).
  return { kind: 'delivered', spellNo, context }
}
