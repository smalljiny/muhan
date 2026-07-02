import { describe, it, expect } from 'vitest'
import { roomStateSchema, type RoomState } from './index.js'

function validRoomState(): RoomState {
  return {
    roomId: 1001,
    exits: [
      { direction: '북', closed: true, locked: false },
      { direction: '남', closed: false, locked: false },
    ],
    respawn: [{ interval: 300, lastDeathTime: 0, mobId: 12 }],
    schemaVersion: 1,
  }
}

describe('roomStateSchema', () => {
  it('유효한 문서를 통과시킨다', () => {
    expect(roomStateSchema.safeParse(validRoomState()).success).toBe(true)
  })

  it('exits·respawn 빈 배열도 통과한다', () => {
    const doc = { ...validRoomState(), exits: [], respawn: [] }
    expect(roomStateSchema.safeParse(doc).success).toBe(true)
  })

  it('roomId가 정수가 아니면 거부한다', () => {
    expect(roomStateSchema.safeParse({ ...validRoomState(), roomId: 'r1001' }).success).toBe(false)
    expect(roomStateSchema.safeParse({ ...validRoomState(), roomId: 1.5 }).success).toBe(false)
  })

  it('roomId(자연키)가 없으면 거부한다 (필수)', () => {
    const doc = validRoomState() as Partial<RoomState>
    delete doc.roomId
    expect(roomStateSchema.safeParse(doc).success).toBe(false)
  })

  it('exit의 closed·locked가 boolean이 아니면 거부한다', () => {
    const doc = { ...validRoomState(), exits: [{ direction: '북', closed: 'yes', locked: false }] }
    expect(roomStateSchema.safeParse(doc).success).toBe(false)
  })

  it('exit에 direction이 없으면 거부한다', () => {
    const doc = { ...validRoomState(), exits: [{ closed: true, locked: false }] }
    expect(roomStateSchema.safeParse(doc).success).toBe(false)
  })

  it('respawn 항목의 interval·lastDeathTime이 정수가 아니면 거부한다', () => {
    const badInterval = {
      ...validRoomState(),
      respawn: [{ interval: 1.5, lastDeathTime: 0, mobId: 12 }],
    }
    expect(roomStateSchema.safeParse(badInterval).success).toBe(false)
    const badTime = {
      ...validRoomState(),
      respawn: [{ interval: 300, lastDeathTime: 'now', mobId: 12 }],
    }
    expect(roomStateSchema.safeParse(badTime).success).toBe(false)
  })

  it('schemaVersion이 없으면 거부한다 (필수)', () => {
    const doc = validRoomState() as Partial<RoomState>
    delete doc.schemaVersion
    expect(roomStateSchema.safeParse(doc).success).toBe(false)
  })
})
