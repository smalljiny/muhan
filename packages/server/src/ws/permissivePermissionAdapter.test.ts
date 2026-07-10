import { describe, it, expect } from 'vitest'
import { createPermissivePermissionAdapter } from './permissivePermissionAdapter.js'
import type { ActorContext } from './actorContext.js'
import type { ClientCommand } from 'shared'

const actor: ActorContext = { accountId: 'acc-1', characterId: 'char-1' }

// permissive 어댑터는 상태·의존 없는 순수 allow다 — 임의 command·actor에 항상 true를 반환한다.
// 실 RBAC 판정은 E5 어댑터 교체로 붙는다(no-op seam 검증).
describe('createPermissivePermissionAdapter', () => {
  it('debug:echo 명령에 대해 true(allow)를 반환한다', () => {
    const permission = createPermissivePermissionAdapter()
    const command: ClientCommand = { type: 'debug:echo', text: '핑' }
    expect(permission.check(command, actor)).toBe(true)
  })

  it('chat:message 명령에 대해서도 true(allow)를 반환한다', () => {
    const permission = createPermissivePermissionAdapter()
    const command: ClientCommand = { type: 'chat:message', channel: 'broadcast', text: '전서버 방송' }
    expect(permission.check(command, actor)).toBe(true)
  })

  it('임의 actor(다른 신원)에 대해서도 true(allow)를 반환한다 — 상태·신원 무의존', () => {
    const permission = createPermissivePermissionAdapter()
    const otherActor: ActorContext = { accountId: 'acc-2', characterId: 'char-2' }
    const command: ClientCommand = { type: 'chat:emote', emote: '웃음' }
    expect(permission.check(command, otherActor)).toBe(true)
  })
})
