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

  describe('world:move', () => {
    it('direction이 있으면 통과한다 (id 생략)', () => {
      const parsed = clientCommandSchema.safeParse({ type: 'world:move', direction: '북' })
      expect(parsed.success).toBe(true)
      if (parsed.success && parsed.data.type === 'world:move') {
        expect(parsed.data.direction).toBe('북')
        expect(parsed.data.id).toBeUndefined()
      }
    })

    it('direction + id가 있으면 통과한다', () => {
      const parsed = clientCommandSchema.safeParse({
        type: 'world:move',
        direction: '남',
        id: 'c5',
      })
      expect(parsed.success).toBe(true)
      if (parsed.success && parsed.data.type === 'world:move') {
        expect(parsed.data.id).toBe('c5')
      }
    })

    it('direction이 빈 문자열이면 거부한다', () => {
      expect(
        clientCommandSchema.safeParse({ type: 'world:move', direction: '' }).success,
      ).toBe(false)
    })

    it('direction이 상한(32)을 넘으면 거부한다 (입력 위생)', () => {
      expect(
        clientCommandSchema.safeParse({ type: 'world:move', direction: 'ㄱ'.repeat(33) }).success,
      ).toBe(false)
      // 상한 이내는 통과한다(경계값).
      expect(
        clientCommandSchema.safeParse({ type: 'world:move', direction: 'ㄱ'.repeat(32) }).success,
      ).toBe(true)
    })

    it('알 수 없는 키를 거부한다 (strict)', () => {
      expect(
        clientCommandSchema.safeParse({ type: 'world:move', direction: '북', extra: true }).success,
      ).toBe(false)
    })
  })

  describe('progress:train', () => {
    it('id 없이도 통과한다 (인자 없는 명령)', () => {
      const parsed = clientCommandSchema.safeParse({ type: 'progress:train' })
      expect(parsed.success).toBe(true)
      if (parsed.success && parsed.data.type === 'progress:train') {
        expect(parsed.data.id).toBeUndefined()
      }
    })

    it('id가 있으면 통과하고 상관 키를 보존한다', () => {
      const parsed = clientCommandSchema.safeParse({ type: 'progress:train', id: 't1' })
      expect(parsed.success).toBe(true)
      if (parsed.success && parsed.data.type === 'progress:train') {
        expect(parsed.data.id).toBe('t1')
      }
    })

    it('알 수 없는 키를 거부한다 (strict)', () => {
      expect(
        clientCommandSchema.safeParse({ type: 'progress:train', extra: true }).success,
      ).toBe(false)
    })

    it('id가 문자열이 아니면 거부한다', () => {
      expect(clientCommandSchema.safeParse({ type: 'progress:train', id: 42 }).success).toBe(false)
    })
  })

  describe('progress:study', () => {
    it('target만 있으면 통과한다 (ordinal·id 생략)', () => {
      const parsed = clientCommandSchema.safeParse({ type: 'progress:study', target: '비법서' })
      expect(parsed.success).toBe(true)
      if (parsed.success && parsed.data.type === 'progress:study') {
        expect(parsed.data.target).toBe('비법서')
        expect(parsed.data.ordinal).toBeUndefined()
        expect(parsed.data.id).toBeUndefined()
      }
    })

    it('target + ordinal + id가 있으면 통과한다', () => {
      const parsed = clientCommandSchema.safeParse({
        type: 'progress:study',
        target: '비법서',
        ordinal: 2,
        id: 's1',
      })
      expect(parsed.success).toBe(true)
      if (parsed.success && parsed.data.type === 'progress:study') {
        expect(parsed.data.ordinal).toBe(2)
        expect(parsed.data.id).toBe('s1')
      }
    })

    it('target이 누락되면 거부한다 (인자 필수 — progress:train과 다르다)', () => {
      expect(clientCommandSchema.safeParse({ type: 'progress:study' }).success).toBe(false)
    })

    it('target이 빈 문자열이면 거부한다', () => {
      expect(
        clientCommandSchema.safeParse({ type: 'progress:study', target: '' }).success,
      ).toBe(false)
    })

    it('target이 상한(32)을 넘으면 거부한다 (world:move.direction 선례의 입력 위생)', () => {
      expect(
        clientCommandSchema.safeParse({ type: 'progress:study', target: 'ㄱ'.repeat(33) }).success,
      ).toBe(false)
      // 상한 이내는 통과한다(경계값).
      expect(
        clientCommandSchema.safeParse({ type: 'progress:study', target: 'ㄱ'.repeat(32) }).success,
      ).toBe(true)
    })

    // 서수 하한 1이 해소자의 ordinal 0 갈래를 라이브에서 도달 불가로 만든다
    // (server/src/items/carriedTargetResolver.ts 헤더의 반대편 기록 참조).
    it('ordinal 0을 거부한다 (하한 1 — 해소자 0 갈래 차단)', () => {
      expect(
        clientCommandSchema.safeParse({ type: 'progress:study', target: '비법서', ordinal: 0 })
          .success,
      ).toBe(false)
      // 하한 경계는 통과한다.
      expect(
        clientCommandSchema.safeParse({ type: 'progress:study', target: '비법서', ordinal: 1 })
          .success,
      ).toBe(true)
    })

    it('ordinal이 상한(99)을 넘거나 정수가 아니면 거부한다', () => {
      expect(
        clientCommandSchema.safeParse({ type: 'progress:study', target: '비법서', ordinal: 100 })
          .success,
      ).toBe(false)
      expect(
        clientCommandSchema.safeParse({ type: 'progress:study', target: '비법서', ordinal: 1.5 })
          .success,
      ).toBe(false)
      // 상한 경계는 통과한다.
      expect(
        clientCommandSchema.safeParse({ type: 'progress:study', target: '비법서', ordinal: 99 })
          .success,
      ).toBe(true)
    })

    it('알 수 없는 키를 거부한다 (strict)', () => {
      expect(
        clientCommandSchema.safeParse({ type: 'progress:study', target: '비법서', extra: true })
          .success,
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
