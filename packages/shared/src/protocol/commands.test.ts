import { describe, it, expect } from 'vitest'
import { clientCommandSchema } from './commands.js'

describe('clientCommandSchema (client→server 봉투)', () => {
  describe('system:ready', () => {
    it('protocolVersion(정수)이 있으면 통과한다', () => {
      const parsed = clientCommandSchema.safeParse({ type: 'system:ready', protocolVersion: 1 })
      expect(parsed.success).toBe(true)
    })

    it('protocolVersion이 정수가 아니면 거부한다', () => {
      expect(
        clientCommandSchema.safeParse({ type: 'system:ready', protocolVersion: 1.5 }).success,
      ).toBe(false)
    })

    it('protocolVersion이 없으면 거부한다', () => {
      expect(clientCommandSchema.safeParse({ type: 'system:ready' }).success).toBe(false)
    })
  })

  describe('debug:echo', () => {
    it('text만 있으면 통과한다 (id 생략)', () => {
      const parsed = clientCommandSchema.safeParse({ type: 'debug:echo', text: '핑' })
      expect(parsed.success).toBe(true)
      if (parsed.success && parsed.data.type === 'debug:echo') {
        expect(parsed.data.id).toBeUndefined()
      }
    })

    it('text + id가 있으면 통과한다', () => {
      const parsed = clientCommandSchema.safeParse({ type: 'debug:echo', text: '핑', id: 'c1' })
      expect(parsed.success).toBe(true)
      if (parsed.success && parsed.data.type === 'debug:echo') {
        expect(parsed.data.id).toBe('c1')
      }
    })

    it('text가 빈 문자열이면 거부한다', () => {
      expect(clientCommandSchema.safeParse({ type: 'debug:echo', text: '' }).success).toBe(false)
    })

    it('알 수 없는 키를 거부한다 (재사용 후에도 strict 유지)', () => {
      expect(
        clientCommandSchema.safeParse({ type: 'debug:echo', text: '핑', extra: true }).success,
      ).toBe(false)
    })
  })

  describe('session:reply', () => {
    it('promptId + value가 있으면 통과한다 (id 생략)', () => {
      const parsed = clientCommandSchema.safeParse({
        type: 'session:reply',
        promptId: 'p1',
        value: '1',
      })
      expect(parsed.success).toBe(true)
      if (parsed.success && parsed.data.type === 'session:reply') {
        expect(parsed.data.promptId).toBe('p1')
        expect(parsed.data.value).toBe('1')
        expect(parsed.data.id).toBeUndefined()
      }
    })

    it('promptId + value + id가 있으면 통과한다', () => {
      const parsed = clientCommandSchema.safeParse({
        type: 'session:reply',
        promptId: 'p1',
        value: '1',
        id: 'c7',
      })
      expect(parsed.success).toBe(true)
      if (parsed.success && parsed.data.type === 'session:reply') {
        expect(parsed.data.id).toBe('c7')
      }
    })

    it('promptId가 빈 문자열이면 거부한다', () => {
      expect(
        clientCommandSchema.safeParse({ type: 'session:reply', promptId: '', value: '1' }).success,
      ).toBe(false)
    })

    it('value가 빈 문자열이면 거부한다', () => {
      expect(
        clientCommandSchema.safeParse({ type: 'session:reply', promptId: 'p1', value: '' }).success,
      ).toBe(false)
    })

    it('알 수 없는 키를 거부한다 (strict)', () => {
      expect(
        clientCommandSchema.safeParse({
          type: 'session:reply',
          promptId: 'p1',
          value: '1',
          extra: true,
        }).success,
      ).toBe(false)
    })
  })

  describe('session:selectCharacter', () => {
    it('characterId가 있으면 통과한다 (id 생략)', () => {
      const parsed = clientCommandSchema.safeParse({
        type: 'session:selectCharacter',
        characterId: 'char-1',
      })
      expect(parsed.success).toBe(true)
      if (parsed.success && parsed.data.type === 'session:selectCharacter') {
        expect(parsed.data.characterId).toBe('char-1')
        expect(parsed.data.id).toBeUndefined()
      }
    })

    it('characterId + id가 있으면 통과한다', () => {
      const parsed = clientCommandSchema.safeParse({
        type: 'session:selectCharacter',
        characterId: 'char-1',
        id: 'c8',
      })
      expect(parsed.success).toBe(true)
      if (parsed.success && parsed.data.type === 'session:selectCharacter') {
        expect(parsed.data.id).toBe('c8')
      }
    })

    it('characterId가 빈 문자열이면 거부한다', () => {
      expect(
        clientCommandSchema.safeParse({ type: 'session:selectCharacter', characterId: '' }).success,
      ).toBe(false)
    })

    it('알 수 없는 키를 거부한다 (strict)', () => {
      expect(
        clientCommandSchema.safeParse({
          type: 'session:selectCharacter',
          characterId: 'char-1',
          extra: true,
        }).success,
      ).toBe(false)
    })
  })

  describe('chat:message', () => {
    it('channel + text가 있으면 통과한다 (id 생략)', () => {
      const parsed = clientCommandSchema.safeParse({
        type: 'chat:message',
        channel: 'say',
        text: '안녕',
      })
      expect(parsed.success).toBe(true)
      if (parsed.success && parsed.data.type === 'chat:message') {
        expect(parsed.data.channel).toBe('say')
        expect(parsed.data.text).toBe('안녕')
        expect(parsed.data.id).toBeUndefined()
      }
    })

    it('channel + text + id가 있으면 통과한다', () => {
      const parsed = clientCommandSchema.safeParse({
        type: 'chat:message',
        channel: 'broadcast',
        text: '방송',
        id: 'c3',
      })
      expect(parsed.success).toBe(true)
      if (parsed.success && parsed.data.type === 'chat:message') {
        expect(parsed.data.id).toBe('c3')
      }
    })

    it('yell·broadcast channel도 통과한다', () => {
      expect(
        clientCommandSchema.safeParse({ type: 'chat:message', channel: 'yell', text: '외침' })
          .success,
      ).toBe(true)
    })

    it('channel 미허용값을 거부한다', () => {
      expect(
        clientCommandSchema.safeParse({ type: 'chat:message', channel: 'gtalk', text: '안녕' })
          .success,
      ).toBe(false)
    })

    it('text가 누락되면 거부한다', () => {
      expect(
        clientCommandSchema.safeParse({ type: 'chat:message', channel: 'say' }).success,
      ).toBe(false)
    })

    it('text가 빈 문자열이면 거부한다', () => {
      expect(
        clientCommandSchema.safeParse({ type: 'chat:message', channel: 'say', text: '' }).success,
      ).toBe(false)
    })

    it('text가 상한(512)을 넘으면 거부한다 (전파 대상 필드 DoS floor)', () => {
      expect(
        clientCommandSchema.safeParse({ type: 'chat:message', channel: 'say', text: 'ㄱ'.repeat(513) })
          .success,
      ).toBe(false)
      // 상한 이내는 통과한다(경계값).
      expect(
        clientCommandSchema.safeParse({ type: 'chat:message', channel: 'say', text: 'ㄱ'.repeat(512) })
          .success,
      ).toBe(true)
    })

    it('알 수 없는 키를 거부한다 (strict)', () => {
      expect(
        clientCommandSchema.safeParse({
          type: 'chat:message',
          channel: 'say',
          text: '안녕',
          extra: true,
        }).success,
      ).toBe(false)
    })
  })

  describe('chat:emote', () => {
    it('emote만 있으면 통과한다 (target·text·id 생략)', () => {
      const parsed = clientCommandSchema.safeParse({ type: 'chat:emote', emote: '웃음' })
      expect(parsed.success).toBe(true)
      if (parsed.success && parsed.data.type === 'chat:emote') {
        expect(parsed.data.emote).toBe('웃음')
        expect(parsed.data.target).toBeUndefined()
        expect(parsed.data.text).toBeUndefined()
        expect(parsed.data.id).toBeUndefined()
      }
    })

    it('emote + target + text + id가 있으면 통과한다', () => {
      const parsed = clientCommandSchema.safeParse({
        type: 'chat:emote',
        emote: '인사',
        target: 'char-2',
        text: '반갑다',
        id: 'c4',
      })
      expect(parsed.success).toBe(true)
      if (parsed.success && parsed.data.type === 'chat:emote') {
        expect(parsed.data.target).toBe('char-2')
        expect(parsed.data.text).toBe('반갑다')
        expect(parsed.data.id).toBe('c4')
      }
    })

    it('emote가 누락되면 거부한다', () => {
      expect(clientCommandSchema.safeParse({ type: 'chat:emote' }).success).toBe(false)
    })

    it('emote가 빈 문자열이면 거부한다', () => {
      expect(clientCommandSchema.safeParse({ type: 'chat:emote', emote: '' }).success).toBe(false)
    })

    it('emote·target·text가 상한을 넘으면 거부한다 (DoS floor)', () => {
      expect(
        clientCommandSchema.safeParse({ type: 'chat:emote', emote: 'ㄱ'.repeat(65) }).success,
      ).toBe(false)
      expect(
        clientCommandSchema.safeParse({ type: 'chat:emote', emote: '웃음', target: 'ㄱ'.repeat(65) })
          .success,
      ).toBe(false)
      expect(
        clientCommandSchema.safeParse({ type: 'chat:emote', emote: '웃음', text: 'ㄱ'.repeat(513) })
          .success,
      ).toBe(false)
    })

    it('알 수 없는 키를 거부한다 (strict)', () => {
      expect(
        clientCommandSchema.safeParse({ type: 'chat:emote', emote: '웃음', extra: true }).success,
      ).toBe(false)
    })
  })

  it('event 전용 type(system:hello)을 거부한다', () => {
    expect(
      clientCommandSchema.safeParse({ type: 'system:hello', protocolVersion: 1 }).success,
    ).toBe(false)
  })

  it('알 수 없는 discriminator를 거부한다', () => {
    expect(clientCommandSchema.safeParse({ type: 'nope' }).success).toBe(false)
  })
})
