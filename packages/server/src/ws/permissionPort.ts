import type { ClientCommand } from 'shared'
import type { ActorContext } from './actorContext.js'

/**
 * 권한 판정 포트 — 검증된 명령을 어느 actor가 실행할 자격이 있는지 판정하는 도메인 계약의 단일 출처.
 *
 * 이 인터페이스는 실 RBAC(역할·클래스·레벨·flag 기반 자격 판정)를 표현하지 않는다. "이 actor가 이
 * 명령을 실행해도 되는가"라는 게임 권한 도메인 언어로만 표현하며, 실 판정은 포트 뒤 어댑터 교체로 붙는다
 * (DIP seam). E3에는 실 판정을 두지 않고 항상 allow하는 permissive 어댑터로만 만족한다 —
 * sessionAuthPort·sessionLifecyclePort·channelPort의 seam 관례를 미러한다.
 *
 * 동기 시그니처: permissive stub이라 check가 Promise를 반환하지 않는다. E5의 실 RBAC 어댑터가 캐릭터
 * 상태·역할 저장소를 async 조회해야 하면 그 시점에 포트를 `Promise<boolean>` 반환으로 확장하고 호출부
 * (dispatch)를 조정한다. 지금은 async seam을 주석으로만 남기고 동기로 유지한다.
 */
export interface PermissionPort {
  /**
   * actor가 command를 실행할 자격이 있는지 판정한다. true=allow(통과), false=deny(거부).
   * dispatch가 payload 검증(safeParse) 성공 후·핸들러 실행 전에 호출하며, deny 시 forbidden으로 거부한다.
   */
  check(command: ClientCommand, actor: ActorContext): boolean
}
