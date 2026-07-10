import { describe, it, expect } from 'vitest'
import { CHANNEL_METADATA } from './channelPort.js'

// 선언적 채널 메타데이터 검증 — E3는 어느 항목도 강제하지 않는다(선언만). 이 스펙은 테이블에
// 필수 선언 항목이 존재함만 고정한다(강제는 E4/E5/E7 어댑터의 책임).
describe('CHANNEL_METADATA (선언만·미강제)', () => {
  it('4개 채널(say·yell·broadcast·emote)을 선언한다', () => {
    expect(Object.keys(CHANNEL_METADATA).sort()).toEqual(
      ['broadcast', 'emote', 'say', 'yell'].sort(),
    )
  })

  it('broadcast.gate에 레벨 자격(minLevel) 항목이 존재한다 (선언 검증)', () => {
    expect(CHANNEL_METADATA.broadcast.gate.minLevel).toBe(20)
  })

  it('각 채널이 audience·cost·gate 선언을 갖는다', () => {
    for (const meta of Object.values(CHANNEL_METADATA)) {
      expect(meta).toHaveProperty('audience')
      expect(meta).toHaveProperty('cost')
      expect(meta).toHaveProperty('gate')
    }
  })
})
