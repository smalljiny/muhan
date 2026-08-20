import { describe, it, expect } from 'vitest'
import { resolveHpMax, resolveMpMax, serverEventSchema } from 'shared'
import { makeCharacter } from '../world/characterFixtures.testutil.js'
import { characterStatsEvent } from './characterStatsEvent.js'

/**
 * `character:stats` 투영 헬퍼 스펙.
 *
 * 이 헬퍼는 여러 명령(공격·연마·훈련)이 공유하는 단일 생산자다 — 각자 투영하면 같은 이벤트의
 * 필드 파생 규칙이 갈린다. 그래서 여기서 고정하는 것은 **어느 값이 문서에서 오고 어느 값이
 * 파생인가**다: 4필드는 캐릭터 문서 그대로, 최대치 2필드는 `resolveHpMax`·`resolveMpMax` 파생이다
 * (저장하지 않는 compute-on-read 계약).
 */
describe('characterStatsEvent', () => {
  it('hpCurrent·mpCurrent·experience·level을 캐릭터 문서에서 그대로 싣는다', () => {
    const character = makeCharacter({
      hpCurrent: 33,
      mpCurrent: 7,
      experience: 4200,
      level: 9,
    })

    expect(characterStatsEvent(character)).toMatchObject({
      type: 'character:stats',
      hpCurrent: 33,
      mpCurrent: 7,
      experience: 4200,
      level: 9,
    })
  })

  it('hpMax·mpMax를 resolveHpMax·resolveMpMax로 파생한다 (저장값 아님)', () => {
    const character = makeCharacter({ class: 4, level: 12 })

    const event = characterStatsEvent(character)

    expect(event.hpMax).toBe(resolveHpMax(character))
    expect(event.mpMax).toBe(resolveMpMax(character))
  })

  it('CARETAKER(초인) 오버라이드가 그대로 반영된다 — 최대치 산술을 재구현하지 않았다', () => {
    const event = characterStatsEvent(makeCharacter({ class: 10, level: 1 }))

    expect(event.hpMax).toBe(800)
    expect(event.mpMax).toBe(600)
  })

  it('발화 이벤트가 와이어 계약(serverEventSchema)을 통과한다', () => {
    const parsed = serverEventSchema.safeParse(characterStatsEvent(makeCharacter()))

    expect(parsed.success).toBe(true)
  })
})
