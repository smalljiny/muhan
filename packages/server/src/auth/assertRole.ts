import type { Account } from 'shared'

/**
 * RBAC 인가 seam — 계정 role에 대한 계층적 권한 게이트.
 *
 * 정책은 계층적(hierarchical)이다: player < builder < dm < admin. 요구 role보다 rank가 높거나
 * 같으면 통과하고(예: dm은 builder 게이트를 통과, admin은 모든 게이트를 통과, player는 dm 게이트에서
 * 실패), 낮으면 RoleError를 던진다. exact-equality가 아니라 `>=` 비교다.
 *
 * 이 모듈은 인가 seam(함수 + 계약 에러)만 제공한다. 실제 권한 게이트 명령(누가 무엇을 실행할 수
 * 있는지의 명령별 배선)은 A13으로 유예된다 — 이 Story는 assertRole 함수와 role 필드만 두며,
 * RBAC 권한 어댑터를 command dispatch에 배선하지 않는다(기본 permissionPort는 permissive 유지).
 */

/**
 * role rank 순서의 단일 출처. enum 인덱스에서 파생하지 않고 명시 map으로 고정한다 —
 * 순서(player < builder < dm < admin)는 이 map이 유일한 정의이며, enum 선언 순서 변경에
 * 영향받지 않는다.
 */
const ROLE_RANK: Record<Account['role'], number> = {
  player: 0,
  builder: 1,
  dm: 2,
  admin: 3,
}

/**
 * 권한 등급 부족 시 던지는 계약 에러 — assertRole이 계정 role rank가 요구 role rank보다
 * 낮을 때 던진다. OwnershipError·DocumentNotFoundError 선례처럼 어댑터가 아니라 인가 계약에
 * 산다(A13 소비자가 이를 catch해 프로토콜 error로 매핑한다).
 */
export class RoleError extends Error {
  constructor(role: Account['role'], requiredRole: Account['role']) {
    super(`권한 등급이 부족합니다: role=${role} required=${requiredRole}`)
    this.name = 'RoleError'
  }
}

/**
 * 계정 role이 요구 role 이상인지 계층적으로 확인한다(순수 함수, 전역 상태 없음).
 * rank가 요구 rank 이상이면 void 반환, 미만이면 RoleError를 던진다. account는 role만 참조하므로
 * `Pick<Account, 'role'>`으로 받아 호출자가 계정 객체(또는 role만 담은 객체)를 그대로 넘길 수 있다.
 */
export function assertRole(account: Pick<Account, 'role'>, requiredRole: Account['role']): void {
  // fail-closed: enum 밖 role 값이 (미검증 DB 문서 등으로) 새어 들어오면 ROLE_RANK 조회가 undefined이고
  // `undefined >= n`·`n >= undefined`는 JS에서 false이므로 throw 경로로 떨어진다(default-deny — A13 소비자
  // 안전 방향). 타입상 도달 불가하나 인가 primitive의 안전 속성으로 의도한 동작이다.
  if (ROLE_RANK[account.role] >= ROLE_RANK[requiredRole]) return
  throw new RoleError(account.role, requiredRole)
}
