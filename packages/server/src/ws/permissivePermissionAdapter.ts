import type { PermissionPort } from './permissionPort.js'

/**
 * PermissionPort의 permissive(항상 allow) 구현.
 *
 * mock이 아니라 실제 어댑터다 — 모든 명령을 무조건 통과시키고 실 RBAC 판정은 하지 않는다(E5가 실 역할·
 * 자격 판정 어댑터로 교체한다). 상태·의존이 없는 순수 allow라 로거·자원을 소유하지 않는다
 * (noopChannelAdapter·noopSessionLifecycleAdapter의 seam 관례를 미러하되, 로깅할 부수효과가 없어 로거를
 * 받지 않는다). check는 command·actor를 읽지 않고 항상 true를 반환한다.
 */
export function createPermissivePermissionAdapter(): PermissionPort {
  return {
    check: () => true,
  }
}
