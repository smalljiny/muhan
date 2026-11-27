import { describe, it, expect } from 'vitest'
import { createTickAwardCollector } from './tickAwardCollector.js'

/**
 * tick 범위 경험치 수령자 수집기 — 사망 seam 관찰자(`onCreatureDeathAwards`)가 넘긴 수령자를
 * combatTick 호출 하나(`begin()`~`end()`) 안에서만 모은다(스펙 §3.4 "경험치 수령자 수집").
 * 오프너 처치처럼 범위 밖에서 실행된 관찰자 호출은 아무것도 남기지 않아야 한다.
 */
describe('createTickAwardCollector', () => {
  it('begin()~end() 사이의 record는 합집합으로 누적된다', () => {
    const collector = createTickAwardCollector()
    collector.begin()
    collector.record(['a', 'b'])
    collector.record(['b', 'c'])
    expect([...collector.current()]).toEqual(['a', 'b', 'c'])
    collector.end()
  })

  it('begin() 전의 record는 무시한다(오프너 처치 경로)', () => {
    const collector = createTickAwardCollector()
    collector.record(['opener'])
    collector.begin()
    expect(collector.current().size).toBe(0)
    collector.end()
  })

  it('end() 뒤의 record는 무시한다', () => {
    const collector = createTickAwardCollector()
    collector.begin()
    collector.end()
    collector.record(['late'])
    expect(collector.current().size).toBe(0)
  })

  it('end() 후 current()는 빈 집합이다', () => {
    const collector = createTickAwardCollector()
    collector.begin()
    collector.record(['a'])
    collector.end()
    expect(collector.current().size).toBe(0)
  })

  it('begin()은 이전 잔여를 비운다(end 없이 다시 begin해도)', () => {
    const collector = createTickAwardCollector()
    collector.begin()
    collector.record(['stale'])
    collector.begin()
    expect(collector.current().size).toBe(0)
    collector.record(['fresh'])
    expect([...collector.current()]).toEqual(['fresh'])
    collector.end()
  })

  it('빈 목록 record는 아무것도 더하지 않는다', () => {
    const collector = createTickAwardCollector()
    collector.begin()
    collector.record([])
    expect(collector.current().size).toBe(0)
    collector.end()
  })

  it('current()는 복사본이 아니라 수집 집합의 읽기 전용 뷰다(통지 콜백 안에서만 읽는다)', () => {
    const collector = createTickAwardCollector()
    collector.begin()
    collector.record(['a'])
    const view = collector.current()
    expect(collector.current()).toBe(view)
    collector.record(['b'])
    expect([...view]).toEqual(['a', 'b'])
    collector.end()
    // 범위가 끝나면 같은 뷰도 비워진다 — 참조를 보관하면 안 되는 이유다.
    expect(view.size).toBe(0)
  })

  it('record에 넘긴 배열을 변형하지 않는다', () => {
    const collector = createTickAwardCollector()
    const ids = Object.freeze(['a', 'b'])
    collector.begin()
    expect(() => collector.record(ids)).not.toThrow()
    expect(ids).toEqual(['a', 'b'])
    collector.end()
  })
})
