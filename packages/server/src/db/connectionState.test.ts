import { describe, it, expect } from 'vitest'
import { createConnectionState } from './connection.js'

// SDAM heartbeat 핸들러 단위 테스트 — 실제 mongod 중단/재시작 타이밍에 의존하지 않고
// 플래그 전이만 직접 검증한다("단절 시 플래그 변화" 기준을 결정적으로 커버).
describe('createConnectionState', () => {
  it('초기 상태는 연결 안 됨(false)이다', () => {
    const state = createConnectionState()
    expect(state.isConnected()).toBe(false)
  })

  it('heartbeat 성공 시 플래그가 true로 뒤집힌다', () => {
    const state = createConnectionState()
    state.onHeartbeatSucceeded()
    expect(state.isConnected()).toBe(true)
  })

  it('heartbeat 실패 시 플래그가 false로 뒤집힌다', () => {
    const state = createConnectionState()
    state.onHeartbeatSucceeded()
    expect(state.isConnected()).toBe(true)
    state.onHeartbeatFailed()
    expect(state.isConnected()).toBe(false)
  })
})
