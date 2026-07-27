import { describe, it, expect } from 'vitest'
import { serverEventSchema, errorCodeSchema } from './events.js'

describe('errorCodeSchema', () => {
  it.each(['handshake_required', 'unknown_type', 'bad_payload', 'internal'])(
    '기존 %s 코드를 통과시킨다 (회귀 보존)',
    (code) => {
      expect(errorCodeSchema.safeParse(code).success).toBe(true)
    },
  )

  it.each(['unauthorized', 'session_state', 'forbidden'])('신규 %s 코드를 통과시킨다', (code) => {
    expect(errorCodeSchema.safeParse(code).success).toBe(true)
  })

  it('rate_limited 코드를 통과시킨다 (인바운드 속도 상한 초과 drop 통지)', () => {
    expect(errorCodeSchema.safeParse('rate_limited').success).toBe(true)
  })

  it('rule_rejected 코드를 통과시킨다 (게임 규칙 거부 — 잠긴 문·막힌 길)', () => {
    expect(errorCodeSchema.safeParse('rule_rejected').success).toBe(true)
  })

  it('알 수 없는 코드를 거부한다', () => {
    expect(errorCodeSchema.safeParse('teapot').success).toBe(false)
  })
})

describe('serverEventSchema (server→client 봉투)', () => {
  describe('system:hello', () => {
    it('protocolVersion(정수)이 있으면 통과한다', () => {
      expect(
        serverEventSchema.safeParse({ type: 'system:hello', protocolVersion: 1 }).success,
      ).toBe(true)
    })

    it('protocolVersion이 정수가 아니면 거부한다', () => {
      expect(
        serverEventSchema.safeParse({ type: 'system:hello', protocolVersion: 1.5 }).success,
      ).toBe(false)
    })
  })

  describe('system:reload', () => {
    it('reason(문자열)이 있으면 통과한다', () => {
      expect(
        serverEventSchema.safeParse({ type: 'system:reload', reason: '월드 리로드' }).success,
      ).toBe(true)
    })

    it('reason이 없으면 거부한다', () => {
      expect(serverEventSchema.safeParse({ type: 'system:reload' }).success).toBe(false)
    })
  })

  describe('debug:echo:result', () => {
    it('text만 있으면 통과한다 (correlationId 생략)', () => {
      const parsed = serverEventSchema.safeParse({ type: 'debug:echo:result', text: '퐁' })
      expect(parsed.success).toBe(true)
      if (parsed.success && parsed.data.type === 'debug:echo:result') {
        expect(parsed.data.correlationId).toBeUndefined()
      }
    })

    it('text + correlationId가 있으면 통과한다', () => {
      const parsed = serverEventSchema.safeParse({
        type: 'debug:echo:result',
        text: '퐁',
        correlationId: 'c1',
      })
      expect(parsed.success).toBe(true)
      if (parsed.success && parsed.data.type === 'debug:echo:result') {
        expect(parsed.data.correlationId).toBe('c1')
      }
    })

    it('알 수 없는 키를 거부한다 (재사용 후에도 strict 유지)', () => {
      expect(
        serverEventSchema.safeParse({ type: 'debug:echo:result', text: '퐁', extra: 1 }).success,
      ).toBe(false)
    })
  })

  describe('error', () => {
    it('code + message가 있으면 통과한다 (correlationId 생략)', () => {
      const parsed = serverEventSchema.safeParse({
        type: 'error',
        code: 'bad_payload',
        message: '형식 오류',
      })
      expect(parsed.success).toBe(true)
      if (parsed.success && parsed.data.type === 'error') {
        expect(parsed.data.correlationId).toBeUndefined()
      }
    })

    it('code + message + correlationId가 있으면 통과한다', () => {
      const parsed = serverEventSchema.safeParse({
        type: 'error',
        code: 'handshake_required',
        message: '핸드셰이크 필요',
        correlationId: 'c9',
      })
      expect(parsed.success).toBe(true)
      if (parsed.success && parsed.data.type === 'error') {
        expect(parsed.data.correlationId).toBe('c9')
      }
    })

    it('알 수 없는 code를 거부한다', () => {
      expect(
        serverEventSchema.safeParse({ type: 'error', code: 'teapot', message: 'x' }).success,
      ).toBe(false)
    })
  })

  describe('session:prompt', () => {
    it('promptId + kind만 있으면 통과한다 (options 생략)', () => {
      const parsed = serverEventSchema.safeParse({
        type: 'session:prompt',
        promptId: 'p1',
        kind: 'selectCharacter',
      })
      expect(parsed.success).toBe(true)
      if (parsed.success && parsed.data.type === 'session:prompt') {
        expect(parsed.data.promptId).toBe('p1')
        expect(parsed.data.kind).toBe('selectCharacter')
        expect(parsed.data.options).toBeUndefined()
      }
    })

    it('구조화된 options 배열이 있으면 통과한다', () => {
      const parsed = serverEventSchema.safeParse({
        type: 'session:prompt',
        promptId: 'p1',
        kind: 'selectCharacter',
        options: [
          { value: 'char-1', label: '테스토스' },
          { value: 'char-2', label: '타이' },
        ],
      })
      expect(parsed.success).toBe(true)
      if (parsed.success && parsed.data.type === 'session:prompt') {
        expect(parsed.data.options?.[0]?.value).toBe('char-1')
      }
    })

    it('kind가 유효하지 않으면 거부한다', () => {
      expect(
        serverEventSchema.safeParse({ type: 'session:prompt', promptId: 'p1', kind: 'confirm' })
          .success,
      ).toBe(false)
    })

    it('promptId가 빈 문자열이면 거부한다', () => {
      expect(
        serverEventSchema.safeParse({ type: 'session:prompt', promptId: '', kind: 'createField' })
          .success,
      ).toBe(false)
    })

    it('option 원소가 label을 빠뜨리면 거부한다', () => {
      expect(
        serverEventSchema.safeParse({
          type: 'session:prompt',
          promptId: 'p1',
          kind: 'selectCharacter',
          options: [{ value: 'char-1' }],
        }).success,
      ).toBe(false)
    })

    it('알 수 없는 키를 거부한다 (strict)', () => {
      expect(
        serverEventSchema.safeParse({
          type: 'session:prompt',
          promptId: 'p1',
          kind: 'createField',
          extra: true,
        }).success,
      ).toBe(false)
    })
  })

  describe('session:characterList', () => {
    it('CharacterSummary 배열이 있으면 통과한다', () => {
      const parsed = serverEventSchema.safeParse({
        type: 'session:characterList',
        characters: [{ characterId: 'char-1', name: '테스토스', class: 1, race: 2, level: 5 }],
      })
      expect(parsed.success).toBe(true)
      if (parsed.success && parsed.data.type === 'session:characterList') {
        expect(parsed.data.characters[0]?.characterId).toBe('char-1')
      }
    })

    it('빈 배열도 통과한다', () => {
      expect(
        serverEventSchema.safeParse({ type: 'session:characterList', characters: [] }).success,
      ).toBe(true)
    })

    it('요약이 필수 필드를 빠뜨리면 거부한다', () => {
      expect(
        serverEventSchema.safeParse({
          type: 'session:characterList',
          characters: [{ characterId: 'char-1', name: '테스토스', class: 1, race: 2 }],
        }).success,
      ).toBe(false)
    })
  })

  describe('session:entered', () => {
    it('characterId가 있으면 통과한다', () => {
      const parsed = serverEventSchema.safeParse({
        type: 'session:entered',
        characterId: 'char-1',
      })
      expect(parsed.success).toBe(true)
      if (parsed.success && parsed.data.type === 'session:entered') {
        expect(parsed.data.characterId).toBe('char-1')
      }
    })

    it('characterId가 빈 문자열이면 거부한다', () => {
      expect(
        serverEventSchema.safeParse({ type: 'session:entered', characterId: '' }).success,
      ).toBe(false)
    })

    it('알 수 없는 키를 거부한다 (strict)', () => {
      expect(
        serverEventSchema.safeParse({ type: 'session:entered', characterId: 'char-1', extra: 1 })
          .success,
      ).toBe(false)
    })
  })

  describe('session:resumed', () => {
    it('characterId가 있으면 통과한다', () => {
      const parsed = serverEventSchema.safeParse({
        type: 'session:resumed',
        characterId: 'char-1',
      })
      expect(parsed.success).toBe(true)
      if (parsed.success && parsed.data.type === 'session:resumed') {
        expect(parsed.data.characterId).toBe('char-1')
      }
    })

    it('characterId가 빈 문자열이면 거부한다', () => {
      expect(
        serverEventSchema.safeParse({ type: 'session:resumed', characterId: '' }).success,
      ).toBe(false)
    })

    it('characterId가 없으면 거부한다', () => {
      expect(serverEventSchema.safeParse({ type: 'session:resumed' }).success).toBe(false)
    })

    it('알 수 없는 키를 거부한다 (strict)', () => {
      expect(
        serverEventSchema.safeParse({ type: 'session:resumed', characterId: 'char-1', extra: 1 })
          .success,
      ).toBe(false)
    })
  })

  describe('world:room', () => {
    it('roomId 0 + 빈 exits 배열이 있으면 통과한다', () => {
      const parsed = serverEventSchema.safeParse({ type: 'world:room', roomId: 0, exits: [] })
      expect(parsed.success).toBe(true)
      if (parsed.success && parsed.data.type === 'world:room') {
        expect(parsed.data.roomId).toBe(0)
        expect(parsed.data.exits).toEqual([])
      }
    })

    it('roomId + exits 이름 목록이 있으면 통과한다', () => {
      const parsed = serverEventSchema.safeParse({
        type: 'world:room',
        roomId: 5,
        exits: ['북', '남'],
      })
      expect(parsed.success).toBe(true)
      if (parsed.success && parsed.data.type === 'world:room') {
        expect(parsed.data.roomId).toBe(5)
        expect(parsed.data.exits).toEqual(['북', '남'])
      }
    })

    it('roomId가 음수이면 거부한다', () => {
      expect(
        serverEventSchema.safeParse({ type: 'world:room', roomId: -1, exits: [] }).success,
      ).toBe(false)
    })

    it('roomId가 정수가 아니면 거부한다 (z.int 경계)', () => {
      expect(
        serverEventSchema.safeParse({ type: 'world:room', roomId: 1.5, exits: [] }).success,
      ).toBe(false)
    })

    it('알 수 없는 키를 거부한다 (strict)', () => {
      expect(
        serverEventSchema.safeParse({ type: 'world:room', roomId: 0, exits: [], extra: 1 }).success,
      ).toBe(false)
    })
  })

  describe('chat:said', () => {
    it('모든 필드가 있으면 통과한다', () => {
      const parsed = serverEventSchema.safeParse({
        type: 'chat:said',
        channel: 'say',
        speakerCharacterId: 'char-1',
        text: '안녕',
        target: 'char-2',
      })
      expect(parsed.success).toBe(true)
      if (parsed.success && parsed.data.type === 'chat:said') {
        expect(parsed.data.channel).toBe('say')
        expect(parsed.data.speakerCharacterId).toBe('char-1')
        expect(parsed.data.text).toBe('안녕')
        expect(parsed.data.target).toBe('char-2')
      }
    })

    it('target 없이도 통과한다', () => {
      const parsed = serverEventSchema.safeParse({
        type: 'chat:said',
        channel: 'emote',
        speakerCharacterId: 'char-1',
        text: '웃는다',
      })
      expect(parsed.success).toBe(true)
      if (parsed.success && parsed.data.type === 'chat:said') {
        expect(parsed.data.target).toBeUndefined()
      }
    })

    it('text가 빈 문자열이면 거부한다', () => {
      expect(
        serverEventSchema.safeParse({
          type: 'chat:said',
          channel: 'say',
          speakerCharacterId: 'char-1',
          text: '',
        }).success,
      ).toBe(false)
    })

    it('speakerCharacterId가 빈 문자열이면 거부한다', () => {
      expect(
        serverEventSchema.safeParse({
          type: 'chat:said',
          channel: 'say',
          speakerCharacterId: '',
          text: '안녕',
        }).success,
      ).toBe(false)
    })

    it('channel 미허용값을 거부한다', () => {
      expect(
        serverEventSchema.safeParse({
          type: 'chat:said',
          channel: 'gtalk',
          speakerCharacterId: 'char-1',
          text: '안녕',
        }).success,
      ).toBe(false)
    })

    it('text가 상한(512)을 넘으면 거부하고 경계값(512)은 통과한다 (전파 대상 DoS floor)', () => {
      expect(
        serverEventSchema.safeParse({
          type: 'chat:said',
          channel: 'say',
          speakerCharacterId: 'char-1',
          text: 'ㄱ'.repeat(513),
        }).success,
      ).toBe(false)
      expect(
        serverEventSchema.safeParse({
          type: 'chat:said',
          channel: 'say',
          speakerCharacterId: 'char-1',
          text: 'ㄱ'.repeat(512),
        }).success,
      ).toBe(true)
    })

    it('target이 상한(64)을 넘으면 거부한다', () => {
      expect(
        serverEventSchema.safeParse({
          type: 'chat:said',
          channel: 'say',
          speakerCharacterId: 'char-1',
          text: '안녕',
          target: 'ㄱ'.repeat(65),
        }).success,
      ).toBe(false)
    })

    it('알 수 없는 키를 거부한다 (strict)', () => {
      expect(
        serverEventSchema.safeParse({
          type: 'chat:said',
          channel: 'say',
          speakerCharacterId: 'char-1',
          text: '안녕',
          extra: true,
        }).success,
      ).toBe(false)
    })
  })

  it('command 전용 type(debug:echo)을 거부한다', () => {
    expect(serverEventSchema.safeParse({ type: 'debug:echo', text: '핑' }).success).toBe(false)
  })

  it('알 수 없는 discriminator를 거부한다', () => {
    expect(serverEventSchema.safeParse({ type: 'nope' }).success).toBe(false)
  })
})
