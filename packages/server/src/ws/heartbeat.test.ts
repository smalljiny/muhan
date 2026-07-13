import { describe, it, expect, vi } from 'vitest'
import { createHeartbeat, type HeartbeatSocket } from './heartbeat.js'
import { FakeClock } from '../util/clock.testutil.js'

// 하트비트는 순수 로직이라 fake socket + 주입한 fake clock으로 결정적으로 검증한다.
// injectWS로 제어 프레임(ping/pong)을 태우지 않는다 — 라이트-소켓 릴레이 타이밍 불확실성을 피한다.

function createFakeSocket(): HeartbeatSocket & { ping: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> } {
  return { ping: vi.fn(), terminate: vi.fn() }
}

/** 6개 테스트가 공유하는 표준 셋업(간격 1000ms·임계 3, 주입 fake clock). */
function makeHb() {
  const clock = new FakeClock()
  const socket = createFakeSocket()
  const hb = createHeartbeat(socket, {
    pingIntervalMs: 1000,
    maxMissed: 3,
    clock,
  })
  return { hb, socket, clock }
}

describe('createHeartbeat', () => {
  it('ping 간격이 경과하면 ping을 전송한다', () => {
    const { hb, socket, clock } = makeHb()

    hb.start()
    clock.tick(1)

    expect(socket.ping).toHaveBeenCalledTimes(1)
    expect(socket.terminate).not.toHaveBeenCalled()
  })

  it('start는 타이머 핸들을 반환한다 (ctx.heartbeat 배선용)', () => {
    const { hb, socket, clock } = makeHb()

    const handle = hb.start()

    // 핸들은 단순 non-null이 아니라 cleanup이 clear할 수 있는 실제 타이머 핸들이어야 한다
    // (ctx.heartbeat 배선의 계약). 이 핸들로 clear하면 이후 tick에서 ping이 멈춰야 한다.
    expect(handle).toBeDefined()
    clock.clearInterval(handle)
    clock.tick(1)
    expect(socket.ping).not.toHaveBeenCalled()
  })

  it('pong 미수신이 임계에 도달하면 terminate하고 정지한다', () => {
    const { hb, socket, clock } = makeHb()

    hb.start()
    // tick1: ping(missed=0), tick2: missed=1, tick3: missed=2 — 아직 terminate 없음.
    clock.tick(3)
    expect(socket.terminate).not.toHaveBeenCalled()
    expect(socket.ping).toHaveBeenCalledTimes(3)

    // tick4: missed=3 → terminate 후 정지.
    clock.tick(1)
    expect(socket.terminate).toHaveBeenCalledTimes(1)

    // 정지 후 추가 tick은 ping·terminate를 더 발화하지 않는다.
    clock.tick(5)
    expect(socket.ping).toHaveBeenCalledTimes(3)
    expect(socket.terminate).toHaveBeenCalledTimes(1)
  })

  it('notePong이 미스 카운터를 리셋해 terminate를 막는다', () => {
    const { hb, socket, clock } = makeHb()

    hb.start()
    // 매 라운드 pong을 수신하면 미스가 누적되지 않아 terminate가 절대 발화하지 않는다.
    for (let i = 0; i < 20; i += 1) {
      clock.tick(1)
      hb.notePong()
    }

    expect(socket.terminate).not.toHaveBeenCalled()
  })

  it('notePong은 미스 카운터와 pong 대기 플래그를 함께 리셋한다', () => {
    // 2회 미스 누적 후 notePong하면, 이후 임계(3)에 도달하려면 3회의 새 미스가 더 필요하다.
    // notePong이 awaitingPong을 리셋하지 않으면 2회만에 terminate되어 이 검증이 실패한다.
    const { hb, socket, clock } = makeHb()

    hb.start()
    // tick1: ping(missed=0), tick2: missed=1, tick3: missed=2.
    clock.tick(3)
    hb.notePong() // missed=0, awaitingPong=false.

    // tick4: 미스 없음(ping), tick5: missed=1, tick6: missed=2 — 아직 terminate 없음.
    clock.tick(3)
    expect(socket.terminate).not.toHaveBeenCalled()

    // tick7: missed=3 → terminate.
    clock.tick(1)
    expect(socket.terminate).toHaveBeenCalledTimes(1)
  })

  it('stop 후에는 타이머가 발화하지 않는다', () => {
    const { hb, socket, clock } = makeHb()

    hb.start()
    hb.stop()
    clock.tick(5)

    expect(socket.ping).not.toHaveBeenCalled()
    expect(socket.terminate).not.toHaveBeenCalled()
  })
})
