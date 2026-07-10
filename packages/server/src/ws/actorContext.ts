import type { ConnectionContext } from './connection.js'

/**
 * 명령 핸들러가 소비하는 행위자(actor) 컨텍스트 — 누가 이 명령을 실행하는가에 대한 server 도메인 어휘.
 *
 * `sessionAuthPort`의 관례를 미러한다: 포트·핸들러가 사는 server 도메인이 이 타입을 소유하며,
 * shared 프로토콜에는 노출하지 않는다(actor는 소켓 경계 안쪽 개념이지 클라이언트 계약이 아니다).
 *
 * `accountId`·`characterId`는 command 상태에서 항상 확정된 신원이라 `readonly`다(연결 수명 동안 불변).
 * `class`·`level`·`flags`는 권한·게임 규칙 판정이 참조할 캐릭터 상태이나, E3에는 실 캐릭터 상태 조회원이
 * 아직 없어 optional로 둔다 — E4가 실 캐릭터 상태원을 붙일 때 채운다. 지금 채우지 않는 것은 미완이 아니라
 * 조회원 부재를 반영한 의도된 seam이다(핸들러 시그니처는 미리 이 필드를 받도록 열어 둔다). 이 필드들도
 * `readonly`로 둬 E4가 mutation이 아니라 construction-time 대입(새 actor 구성)으로 채우게 강제한다
 * (프로젝트 immutability 규칙 일관).
 */
export interface ActorContext {
  readonly accountId: string
  readonly characterId: string
  readonly class?: number
  readonly level?: number
  readonly flags?: readonly string[]
}

/**
 * 연결 컨텍스트에서 actor 컨텍스트를 구성한다 — command 상태 진입 시 dispatch 호출부가 쓴다.
 *
 * `ctx.account`·`ctx.boundCharacterId`는 command 상태에서 둘 다 non-null이 배선 불변식이다:
 * characterSelect 핸들러가 enterWorld→register/rebind로 boundCharacterId를 대입한 **뒤** FSM이
 * state=command로 전이하므로, command 상태에서 이 둘이 null이면 배선 오류다. 따라서 아래 throw는
 * 순수 방어선이며 런타임 정상 경로에선 도달하지 않는다(`buildSession`의 세션 불변식 위반 선례를 미러).
 *
 * class/level/flags는 채우지 않는다 — E3엔 실 캐릭터 상태 조회원이 없다(ActorContext JSDoc 참조).
 */
export function buildActorContext(ctx: ConnectionContext): ActorContext {
  if (ctx.account === null || ctx.boundCharacterId === null) {
    throw new Error(
      '배선 불변식 위반: command 상태이나 account 또는 boundCharacterId가 없다',
    )
  }
  return { accountId: ctx.account.accountId, characterId: ctx.boundCharacterId }
}
