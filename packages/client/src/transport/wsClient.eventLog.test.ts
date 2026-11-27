// WsClient 이벤트 로그·전송 오류 상한과 seq 수명 회귀 테스트.
import { describe, it, expect } from 'vitest'
import { EVENT_LOG_LIMIT, TRANSPORT_ERROR_LIMIT } from './wsClient.js'
import { makeRoom, roomEvent } from '../test/roomFixtures.testutil.js'
import { makeHarness } from '../test/wsHarness.testutil.js'

describe('WsClient event log bound', () => {
  // connect→fireOpen 뒤 world:room을 count건 흘려보낸다.
  function emitRooms(h: ReturnType<typeof makeHarness>, count: number): void {
    for (let i = 0; i < count; i++) h.last().emit(roomEvent(makeRoom()))
  }

  function openHarness(): ReturnType<typeof makeHarness> {
    const h = makeHarness()
    h.client.connect()
    h.last().fireOpen()
    return h
  }

  it('exports the log and error limits', () => {
    expect(EVENT_LOG_LIMIT).toBe(200)
    expect(TRANSPORT_ERROR_LIMIT).toBe(50)
  })

  it('keeps only the latest EVENT_LOG_LIMIT events with contiguous seq after 1000 events', () => {
    const h = openHarness()
    emitRooms(h, 1000)
    const events = h.client.getSnapshot().events
    // 길이 200, 첫 seq 800, 마지막 seq 999, 인접 차이 1을 한 번에 단정한다.
    expect(events.map((e) => e.seq)).toEqual(Array.from({ length: 200 }, (_, i) => 800 + i))
    expect(events.every((e) => e.event.type === 'world:room')).toBe(true)
  })

  it('preserves seq and reference of retained entries when the oldest one is dropped', () => {
    const h = openHarness()
    emitRooms(h, 200)
    const second = h.client.getSnapshot().events[1]
    expect(second?.seq).toBe(1)
    emitRooms(h, 1)
    const after = h.client.getSnapshot().events
    expect(after).toHaveLength(200)
    expect(after[0]).toBe(second)
    expect(after[0]?.seq).toBe(1)
  })

  it('continues seq across reconnect without clearing the log', () => {
    const h = openHarness()
    emitRooms(h, 3)
    const beforeReconnect = h.client.getSnapshot().events
    h.client.reconnect()
    h.last().fireOpen()
    emitRooms(h, 3)
    const events = h.client.getSnapshot().events
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5])
    beforeReconnect.forEach((entry, i) => expect(events[i]).toBe(entry))
  })

  it('keeps the events reference when only connection state changes', () => {
    const h = openHarness()
    emitRooms(h, 3)
    const before = h.client.getSnapshot().events
    h.client.disconnect()
    expect(h.client.getSnapshot().events).toBe(before)
    h.client.connect()
    h.last().close()
    expect(h.client.getSnapshot().events).toBe(before)
  })

  it('keeps only the latest TRANSPORT_ERROR_LIMIT errors in arrival order', () => {
    const h = openHarness()
    const validCommand = { type: 'debug:echo', text: 'x' }
    h.last().fireError()
    for (let i = 0; i < 25; i++) h.last().emitRaw('}{')
    h.client.disconnect()
    for (let i = 0; i < 24; i++) h.client.send(validCommand)

    const atLimit = h.client.getSnapshot().errors
    expect(atLimit).toHaveLength(50)
    expect(atLimit[0]?.kind).toBe('socket')

    h.client.send(validCommand)
    const errors = h.client.getSnapshot().errors
    expect(errors).toHaveLength(50)
    expect(errors.map((e) => e.kind)).toEqual([
      ...Array<string>(25).fill('parse'),
      ...Array<string>(25).fill('not-connected'),
    ])
    for (let i = 0; i < 49; i++) expect(errors[i]).toBe(atLimit[i + 1])
    // 51번째 오류는 클라이언트 안에서 만들어져 미리 잡을 참조가 없으므로, 새 객체임만 단정한다.
    expect(atLimit).not.toContain(errors[49])
  })
})
