import type { ObjectInstance } from 'shared'
import { POTION, SCROLL, WAND } from './taxonomy.js'
import { evaluateGate } from '../magic/gate.js'
import { NOT_IMPLEMENTED, type SpellDispatch } from '../magic/dispatch.js'
import type { Caster } from '../magic/caster.js'

/**
 * 소비 아이템 magic 배달 seam(magic1.c drink/readscroll/zap · #86).
 *
 * POTION(drink)·SCROLL(readscroll)·WAND(zap)는 담긴 주문(splno=magicpower-1)을 how≠CAST로
 * magic dispatch에 배달하고, 배달된 delivered에서만 shotscur를 1 감소한 새 객체를 반환한다.
 *
 * ## gated=false — 시전 자격 게이트 우회
 * evaluateGate를 gated=false로 호출한다. magic1.c의 마나(mpcur<mp)·knowledge(!S_ISSET) 게이트는
 * how==CAST일 때만 발화하므로, 소비 경로(how≠CAST)는 이를 우회한다 — 콘텐츠(아이템 효과)를
 * 규칙(시전 자격)으로 막지 않는다. applyCastGate가 아니라 evaluateGate를 쓴다(마나 write-through 없음).
 *
 * ## effect 본체 재구현 없음 — 분류만
 * dispatch.resolve로 주문을 분류만 하고 실행하지 않는다. 핸들러 형태(H)는 dispatch.ts에서
 * 제네릭 미확정이라 호출할 수 없다(S5 offensiveSpell 등록 후 command router가 호출).
 */

/** 소비 컨텍스트 — 어느 소비 명령(drink/readscroll/zap) 경로인지. */
export type ConsumeContext = 'potion' | 'scroll' | 'wand'

/**
 * 소비 배달 결과(exhaustive union). 각 케이스는 정확히 한 경로에 안착한다.
 * shotscur는 delivered에서만 감소하고, 나머지는 불변이다(미완성 포트에서 유예 스펠이
 * charge를 조용히 소모하지 않게 한다).
 */
export type ConsumeOutcome =
  // 소비 대상 타입이 아님(type ∉ {POTION,SCROLL,WAND}).
  | { kind: 'noop' }
  // 남은 충전 없음(shotscur < 1) — 오라클 drink shotscur<1 pre-guard.
  | { kind: 'depleted' }
  // 담긴 주문 없음(magicpower < 1 → spellNo=-1).
  | { kind: 'no-spell' }
  // 비-offensive 주문 → NOT_IMPLEMENTED(#85 유예). shotscur 불변.
  | { kind: 'deferred'; spellNo: number; context: ConsumeContext }
  // offensive 미등록 주문 → undefined(핸들러는 magic S5에서 등록). shotscur 불변.
  | { kind: 'unresolved'; spellNo: number; context: ConsumeContext }
  // 핸들러 resolve 성공 → 배달. shotscur -1된 새 객체. (gate는 gated=false로 무조건 우회하므로
  // delivered 도달은 resolve 결과만으로 결정된다 — gate는 검사 조건이 아니다.)
  | { kind: 'delivered'; object: ObjectInstance; spellNo: number; context: ConsumeContext }

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

  // 핸들러 resolve + gate PASS → 배달. shotscur -1된 새 객체(입력 무변경).
  return {
    kind: 'delivered',
    object: { ...instance, shotscur: instance.shotscur - 1 },
    spellNo,
    context,
  }
}
