import { describe, it, expect } from 'vitest'
import { appendBounded } from './appendBounded.js'

describe('appendBounded', () => {
  it('상한 미만이면 기존 항목 뒤에 새 항목이 순서대로 남는다', () => {
    expect(appendBounded([1, 2], 3, 5)).toEqual([1, 2, 3])
  })

  it('빈 배열에 덧붙이면 새 항목 하나만 남는다', () => {
    expect(appendBounded([], 'a', 3)).toEqual(['a'])
  })

  it('상한과 같은 길이에 덧붙이면 맨 앞 1건이 빠지고 길이는 limit이다', () => {
    expect(appendBounded([1, 2, 3], 4, 3)).toEqual([2, 3, 4])
  })

  it('입력이 이미 limit보다 길어도 최근 limit건만 남는다', () => {
    expect(appendBounded([1, 2, 3, 4, 5], 6, 3)).toEqual([4, 5, 6])
  })

  it('남은 객체 원소는 참조가 그대로 유지된다', () => {
    const items = [{ id: 1 }, { id: 2 }, { id: 3 }]
    const added = { id: 4 }
    const result = appendBounded(items, added, 3)
    expect(result[0]).toBe(items[1])
    expect(result[1]).toBe(items[2])
    expect(result[2]).toBe(added)
  })

  it('limit이 1이면 새 항목 하나만 남는다', () => {
    expect(appendBounded([1, 2, 3], 4, 1)).toEqual([4])
  })

  it.each([
    ['상한 미만', [1, 2], 3, 5],
    ['상한 도달', [1, 2, 3], 4, 3],
  ])('입력 배열을 바꾸지 않고 새 참조를 돌려준다(%s)', (_case, input, item, limit) => {
    const copy = [...input]
    const result = appendBounded(input, item, limit)
    expect(input).toEqual(copy)
    expect(result).not.toBe(input)
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'limit이 1 미만이거나 정수가 아니면(%s) RangeError를 던진다',
    (limit) => {
      expect(() => appendBounded([1], 2, limit)).toThrow(RangeError)
    },
  )
})
