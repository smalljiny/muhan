import { describe, it, expect } from 'vitest'
import { serverEventSchema } from './events.js'

/**
 * 전투 이벤트(`combat:attacked`·`combat:round`) 계약 테스트.
 *
 * events.test.ts에서 떼어 낸 파일이다 — 이 이벤트를 더하자 그 파일이 프로젝트 상한(800줄)을
 * 넘겼고, 후속 토픽(#37 채널 이벤트·#122 cast)이 이벤트를 더 붙일 예정이라 갈랐다. 분리 축은
 * "전투"다 — `character:stats`는 전투 전용이 아니라 세 명령이 공유하는 통일 통지 경로라
 * events.test.ts에 남는다. 대상 스키마는 같은 `serverEventSchema`다.
 */
describe('serverEventSchema (전투 이벤트)', () => {
  describe('combat:attacked', () => {
    /** 단일 타격 서술자의 유효 형태. 케이스마다 다른 필드만 덮어써 차이를 드러낸다. */
    const validAttack = {
      hit: true,
      damage: 7,
      critical: false,
      fumble: false,
      durabilityHit: false,
      weaponDropped: false,
    }
    const { durabilityHit: _durabilityHit, ...attackWithoutDurabilityHit } = validAttack

    /** 전투 라운드 통지의 최소 유효 payload. 각 케이스가 필요한 필드만 덮어쓴다. */
    const validAttacked = {
      type: 'combat:attacked',
      targetInstanceId: '3001:c7',
      targetName: '고블린',
      hit: true,
      damage: 7,
      critical: false,
      fumble: false,
      died: false,
      attacks: [validAttack],
    }

    it('전 필드가 채워지면 통과한다', () => {
      const parsed = serverEventSchema.safeParse(validAttacked)
      expect(parsed.success).toBe(true)
      if (parsed.success && parsed.data.type === 'combat:attacked') {
        expect(parsed.data.targetInstanceId).toBe('3001:c7')
        expect(parsed.data.targetName).toBe('고블린')
        expect(parsed.data.damage).toBe(7)
        expect(parsed.data.attacks).toHaveLength(1)
        expect(parsed.data.attacks[0]?.durabilityHit).toBe(false)
      }
    })

    it('attacks가 빈 배열이어도 통과한다 (모두 빗나간 라운드도 통지한다)', () => {
      expect(serverEventSchema.safeParse({ ...validAttacked, attacks: [] }).success).toBe(true)
    })

    it('다중 타격으로 대상이 죽은 라운드를 통과시킨다', () => {
      const parsed = serverEventSchema.safeParse({
        ...validAttacked,
        damage: 19,
        critical: true,
        died: true,
        attacks: [
          { ...validAttack, damage: 7 },
          { ...validAttack, damage: 12, critical: true },
          { ...validAttack, hit: false, damage: 0 },
        ],
      })
      expect(parsed.success).toBe(true)
      if (parsed.success && parsed.data.type === 'combat:attacked') {
        expect(parsed.data.attacks).toHaveLength(3)
        expect(parsed.data.died).toBe(true)
      }
    })

    it('damage 음수를 통과시킨다 (하한 없음 — 집계 결과를 그대로 싣는다)', () => {
      expect(serverEventSchema.safeParse({ ...validAttacked, damage: -1 }).success).toBe(true)
    })

    // 거부 케이스는 형식이 같아 표로 묶는다(world:room·progress:trained 선례).
    it.each([
      ['targetInstanceId 빈 문자열', { targetInstanceId: '' }],
      ['targetName 빈 문자열', { targetName: '' }],
      ['damage 비정수', { damage: 1.5 }],
      ['hit이 boolean이 아님', { hit: 'yes' }],
      ['attacks가 배열이 아님', { attacks: {} }],
      ['attacks 원소의 damage가 비정수', { attacks: [{ ...validAttack, damage: 1.5 }] }],
      // attacks 원소는 AttackDescriptor 7필드에서 specialAttack을 뺀 6필드다(D11) —
      // 미지 필드로 실어 보내면 strict가 막는다.
      ['attacks 원소에 specialAttack 동승', { attacks: [{ ...validAttack, specialAttack: null }] }],
      ['attacks 원소에서 durabilityHit 누락', { attacks: [attackWithoutDurabilityHit] }],
      // 상태 이벤트라 상관 키를 싣지 않는다(progress:trained 선례) — strict가 막는다.
      ['correlationId 동승', { correlationId: 'c1' }],
      ['알 수 없는 키', { extra: true }],
    ])('%s이면 거부한다', (_label, patch) => {
      expect(serverEventSchema.safeParse({ ...validAttacked, ...patch }).success).toBe(false)
    })

    it('필수 필드가 빠지면 거부한다', () => {
      const { died: _died, ...withoutDied } = validAttacked
      expect(serverEventSchema.safeParse(withoutDied).success).toBe(false)

      // targetInstanceId는 대상 짝짓기의 유일한 키라 optional이 아니다 — 누락도 거부된다.
      const { targetInstanceId: _instanceId, ...withoutInstanceId } = validAttacked
      expect(serverEventSchema.safeParse(withoutInstanceId).success).toBe(false)
    })
  })

  describe('combat:round', () => {
    /** 근접 피격 형태의 received. */
    const meleeReceived = { kind: 'melee', hit: true, damage: 12, critical: false, fumble: false }
    /** 시전 피격 형태의 received. */
    const castReceived = { kind: 'cast', damage: 9 }
    /** 반격 결과. */
    const validCounter = { hit: true, damage: 5, critical: false, fumble: false }

    /** 몬스터 tick 라운드 통지의 최소 유효 payload. 각 케이스가 필요한 필드만 덮어쓴다. */
    const validRound = {
      type: 'combat:round',
      creatureInstanceId: '3001:c7',
      creatureName: '고블린',
      received: meleeReceived,
      counter: validCounter,
      monsterDied: false,
      youDied: false,
    }

    it('근접 피격·반격이 담긴 라운드를 통과시킨다', () => {
      const parsed = serverEventSchema.safeParse(validRound)
      expect(parsed.success).toBe(true)
      if (parsed.success && parsed.data.type === 'combat:round') {
        expect(parsed.data.creatureInstanceId).toBe('3001:c7')
        expect(parsed.data.received).toEqual(meleeReceived)
        expect(parsed.data.counter).toEqual(validCounter)
      }
    })

    // received 세 형태: 반격만 한 수신자(null)·근접 표적·시전 표적.
    it.each([
      ['null (반격만 한 수신자)', null],
      ['melee 명중', meleeReceived],
      ['melee 빗맞음 (damage 0)', { ...meleeReceived, hit: false, damage: 0 }],
      ['cast', castReceived],
      ['cast damage 0 (표적 피해 없는 시전)', { kind: 'cast', damage: 0 }],
    ])('received가 %s이면 통과한다', (_label, received) => {
      expect(serverEventSchema.safeParse({ ...validRound, received }).success).toBe(true)
    })

    it.each([
      ['null (반격을 굴리지 않음)', null],
      ['객체', validCounter],
    ])('counter가 %s이면 통과한다', (_label, counter) => {
      expect(serverEventSchema.safeParse({ ...validRound, counter }).success).toBe(true)
    })

    it('몬스터 사망·수신자 사망 라운드를 통과시킨다', () => {
      expect(
        serverEventSchema.safeParse({ ...validRound, monsterDied: true, youDied: true }).success,
      ).toBe(true)
    })

    const { kind: _kind, ...meleeWithoutKind } = meleeReceived
    const { critical: _critical, ...meleeWithoutCritical } = meleeReceived

    // 거부 케이스는 형식이 같아 표로 묶는다(combat:attacked 선례).
    it.each([
      ['creatureInstanceId 빈 문자열', { creatureInstanceId: '' }],
      ['creatureName 빈 문자열', { creatureName: '' }],
      ['received의 kind 누락', { received: meleeWithoutKind }],
      ['received melee의 critical 누락', { received: meleeWithoutCritical }],
      ['received의 kind가 알 수 없는 값', { received: { ...castReceived, kind: 'breath' } }],
      ['received melee에 여분 필드', { received: { ...meleeReceived, extra: true } }],
      ['received cast에 근접 필드 동승', { received: { ...castReceived, hit: true } }],
      ['received damage 비정수', { received: { ...castReceived, damage: 1.5 } }],
      ['counter에 여분 필드', { counter: { ...validCounter, kind: 'melee' } }],
      ['counter damage 비정수', { counter: { ...validCounter, damage: 1.5 } }],
      ['monsterDied가 boolean이 아님', { monsterDied: 'yes' }],
      ['youDied가 boolean이 아님', { youDied: 1 }],
      // 상태 이벤트라 상관 키를 싣지 않는다(combat:attacked 선례) — strict가 막는다.
      ['correlationId 동승', { correlationId: 'c1' }],
      ['알 수 없는 키', { extra: true }],
    ])('%s이면 거부한다', (_label, patch) => {
      expect(serverEventSchema.safeParse({ ...validRound, ...patch }).success).toBe(false)
    })

    it('필수 필드가 빠지면 거부한다', () => {
      const { youDied: _youDied, ...withoutYouDied } = validRound
      expect(serverEventSchema.safeParse(withoutYouDied).success).toBe(false)

      // received·counter는 nullable이지 optional이 아니다 — 누락은 거부된다.
      const { received: _received, ...withoutReceived } = validRound
      expect(serverEventSchema.safeParse(withoutReceived).success).toBe(false)
      const { counter: _counter, ...withoutCounter } = validRound
      expect(serverEventSchema.safeParse(withoutCounter).success).toBe(false)
    })
  })
})
