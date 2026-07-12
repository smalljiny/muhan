import { describe, it, expect } from 'vitest'
import { approve } from './runner.js'
import type { GoldenFixture } from './types.js'

// number 입출력 fixture 팩토리 — SUT는 input.x를 2배 하는 순수 함수.
function doubleFixture(): GoldenFixture<{ x: number }, number> {
  return {
    fn: 'double',
    oracle: {
      method: 'manual',
      source: 'test-inline',
      generatedAt: '2026-07-13T00:00:00.000Z',
      seed: null,
    },
    cases: [
      { input: { x: 1 }, expected: 2 },
      { input: { x: 5 }, expected: 10 },
      { input: { x: 0 }, expected: 0 },
    ],
  }
}

const double = (input: { x: number }): number => input.x * 2

describe('approve', () => {
  it('전 케이스가 통과하는 fixture로 throw 없이 정상 반환한다 (T2.3)', () => {
    expect(() => approve(doubleFixture(), double)).not.toThrow()
  })

  it('불일치가 있으면 throw하고 해당 케이스의 index·expected·actual을 리포트한다 (T2.4)', () => {
    const fixture = doubleFixture()
    // 케이스 1의 expected를 의도적으로 틀리게(10 → 999) 만든다.
    fixture.cases[1] = { input: { x: 5 }, expected: 999 }

    let thrown: Error | undefined
    try {
      approve(fixture, double)
    } catch (err) {
      thrown = err as Error
    }

    expect(thrown).toBeInstanceOf(Error)
    const msg = thrown!.message
    // 러너가 불일치를 실제로 잡아냄 = discrimination 증명.
    expect(msg).toContain('index 1')
    expect(msg).toContain('999') // expected
    expect(msg).toContain('10') // actual(sut 출력)
    expect(msg).toContain('double') // fixture.fn
  })

  it('복수 불일치 시 첫 실패에서 멈추지 않고 전 불일치를 집계한다 (T2.5)', () => {
    const fixture = doubleFixture()
    // 케이스 0·2를 틀리게, 케이스 1은 통과 유지.
    fixture.cases[0] = { input: { x: 1 }, expected: 111 }
    fixture.cases[2] = { input: { x: 0 }, expected: 222 }

    let thrown: Error | undefined
    try {
      approve(fixture, double)
    } catch (err) {
      thrown = err as Error
    }

    expect(thrown).toBeInstanceOf(Error)
    const msg = thrown!.message
    // 케이스 0과 케이스 2 둘 다 메시지에 등장(fail-fast 금지 증명).
    expect(msg).toContain('index 0')
    expect(msg).toContain('index 2')
    // 요약 줄: 3개 케이스 중 2개 불일치.
    expect(msg).toContain('3개 케이스 중 2개 불일치')
  })

  it('객체 출력에서 structural 비교가 동작한다 — 같은 구조는 통과', () => {
    const fixture: GoldenFixture<{ id: number }, { id: number; tag: string }> = {
      fn: 'wrap',
      oracle: {
        method: 'manual',
        source: 'test-inline',
        generatedAt: '2026-07-13T00:00:00.000Z',
        seed: null,
      },
      cases: [{ input: { id: 7 }, expected: { id: 7, tag: 'a' } }],
    }
    const wrap = (input: { id: number }): { id: number; tag: string } => ({
      id: input.id,
      tag: 'a',
    })
    // 참조가 다른 새 객체지만 구조가 같으므로 통과해야 한다.
    expect(() => approve(fixture, wrap)).not.toThrow()
  })

  it('빈 cases fixture는 vacuous-pass 대신 throw한다 (boundary 가드)', () => {
    // 스키마 .min(1)을 우회해 캐스팅된 fixture(cases: [])가 approve로 들어오면,
    // 불일치 0건으로 조용히 통과하는 vacuous-pass가 아니라 즉시 throw해야 한다.
    const fixture: GoldenFixture<{ x: number }, number> = {
      ...doubleFixture(),
      cases: [],
    }
    expect(() => approve(fixture, double)).toThrow(/빈 cases|empty/i)
  })

  it('객체 출력에서 structural 비교가 동작한다 — 다른 구조는 불일치', () => {
    const fixture: GoldenFixture<{ id: number }, { id: number; tag: string }> = {
      fn: 'wrap',
      oracle: {
        method: 'manual',
        source: 'test-inline',
        generatedAt: '2026-07-13T00:00:00.000Z',
        seed: null,
      },
      cases: [{ input: { id: 7 }, expected: { id: 7, tag: 'a' } }],
    }
    const wrongWrap = (input: { id: number }): { id: number; tag: string } => ({
      id: input.id,
      tag: 'b',
    })
    expect(() => approve(fixture, wrongWrap)).toThrow()
  })
})
