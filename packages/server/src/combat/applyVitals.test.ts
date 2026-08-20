import { describe, it, expect } from 'vitest'
import { applyVitals } from './applyVitals.js'
import { makeCharacter } from '../world/characterFixtures.testutil.js'

describe('applyVitals', () => {
  it('hp·mp만 얹고 나머지 필드는 그대로 둔다', () => {
    const character = makeCharacter({ hpCurrent: 42, mpCurrent: 15, experience: 900, level: 7 })

    const next = applyVitals(character, { hpCurrent: 11, mpCurrent: 3 })

    expect(next.hpCurrent).toBe(11)
    expect(next.mpCurrent).toBe(3)
    expect(next.experience).toBe(900)
    expect(next.level).toBe(7)
    expect(next.name).toBe(character.name)
  })

  // 피해 차감에 하한이 없어 음수가 들어올 수 있다. 그대로 내보내면 characterSchema(min 0)와
  // 와이어 character:stats(min 0)가 둘 다 거부하는데, 그 실패가 예외도 로그도 없이 조용하다.
  it.each([
    ['hp 음수', { hpCurrent: -7, mpCurrent: 3 }, 0, 3],
    ['mp 음수', { hpCurrent: 11, mpCurrent: -2 }, 11, 0],
    ['둘 다 음수', { hpCurrent: -1, mpCurrent: -1 }, 0, 0],
    ['둘 다 0 (경계)', { hpCurrent: 0, mpCurrent: 0 }, 0, 0],
  ])('%s이면 하한 0으로 클램프한다', (_label, vitals, expectedHp, expectedMp) => {
    const next = applyVitals(makeCharacter(), vitals)

    expect(next.hpCurrent).toBe(expectedHp)
    expect(next.mpCurrent).toBe(expectedMp)
  })

  it('입력 문서를 변형하지 않는다', () => {
    const character = makeCharacter({ hpCurrent: 42, mpCurrent: 15 })

    applyVitals(character, { hpCurrent: 1, mpCurrent: 1 })

    expect(character.hpCurrent).toBe(42)
    expect(character.mpCurrent).toBe(15)
  })
})
