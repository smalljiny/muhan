import { describe, it, expect, beforeEach } from 'vitest'
import { DirtyTracker } from './dirtyTracker.js'

describe('DirtyTracker', () => {
  let tracker: DirtyTracker

  beforeEach(() => {
    tracker = new DirtyTracker()
  })

  it('같은 collection:id로 markDirty N회 후 drain하면 마지막 스냅샷 1건만 반환한다(coalescing)', () => {
    tracker.markDirty('characters', 'char-1', { v: 1 })
    tracker.markDirty('characters', 'char-1', { v: 2 })
    tracker.markDirty('characters', 'char-1', { v: 3 })

    const drained = tracker.drain()

    expect(drained).toHaveLength(1)
    expect(drained[0]).toEqual({ collection: 'characters', id: 'char-1', snapshot: { v: 3 } })
  })

  it('서로 다른 키 M개 markDirty 후 drain하면 M개를 반환하고 size는 0이 된다', () => {
    tracker.markDirty('characters', 'char-1', { gold: 10 })
    tracker.markDirty('bankAccounts', 'char-1', { balance: 500 })
    tracker.markDirty('roomStates', 'room-42', { open: true })

    const drained = tracker.drain()

    expect(drained).toHaveLength(3)
    expect(drained.map((e) => `${e.collection}:${e.id}`).sort()).toEqual([
      'bankAccounts:char-1',
      'characters:char-1',
      'roomStates:room-42',
    ])
    expect(tracker.size).toBe(0)
  })

  it('drain 이후 registry가 비어 재호출 시 빈 배열을 반환한다', () => {
    tracker.markDirty('characters', 'char-1', { gold: 10 })
    tracker.drain()

    const second = tracker.drain()

    expect(second).toEqual([])
    expect(tracker.size).toBe(0)
  })

  it('markDirty는 전달된 snapshot 객체를 mutate하지 않고 동일 참조를 저장한다', () => {
    const snapshot = { gold: 10, name: '타이' }
    const pristine = { gold: 10, name: '타이' }

    tracker.markDirty('characters', 'char-1', snapshot)

    // (a) 원본 객체가 변경되지 않았다 — 필드 추가·수정 없음
    expect(snapshot).toEqual(pristine)
    // (b) .dirty 플래그가 심어지지 않았다
    expect('dirty' in snapshot).toBe(false)
    // (c) drain된 항목이 원본과 동일 참조를 보관한다
    const drained = tracker.drain()
    expect(drained[0]?.snapshot).toBe(snapshot)
  })

  it('markable 항목이 추가될 때마다 size가 pending 개수를 반영한다', () => {
    expect(tracker.size).toBe(0)
    tracker.markDirty('characters', 'char-1', {})
    expect(tracker.size).toBe(1)
    // 같은 키 재호출은 coalescing되어 size가 증가하지 않는다
    tracker.markDirty('characters', 'char-1', {})
    expect(tracker.size).toBe(1)
    tracker.markDirty('characters', 'char-2', {})
    expect(tracker.size).toBe(2)
  })

  describe('evict (per-key 삭제)', () => {
    it('해당 collection:id 항목만 registry에서 제거하고 다른 키는 남긴다', () => {
      tracker.markDirty('characters', 'char-1', { v: 1 })
      tracker.markDirty('characters', 'char-2', { v: 2 })

      tracker.evict('characters', 'char-1')

      expect(tracker.size).toBe(1)
      const drained = tracker.drain()
      expect(drained).toHaveLength(1)
      expect(drained[0]).toEqual({ collection: 'characters', id: 'char-2', snapshot: { v: 2 } })
    })

    it('존재하지 않는 키를 evict하면 no-op이다(throw 없음, size 불변)', () => {
      tracker.markDirty('characters', 'char-1', { v: 1 })

      expect(() => tracker.evict('characters', 'ghost')).not.toThrow()
      expect(() => tracker.evict('bankAccounts', 'char-1')).not.toThrow()
      expect(tracker.size).toBe(1)
    })

    it('evict한 키를 이후 markDirty하면 다시 pending에 들어간다', () => {
      tracker.markDirty('characters', 'char-1', { v: 1 })
      tracker.evict('characters', 'char-1')
      expect(tracker.size).toBe(0)

      tracker.markDirty('characters', 'char-1', { v: 2 })

      expect(tracker.size).toBe(1)
      expect(tracker.drain()[0]).toEqual({ collection: 'characters', id: 'char-1', snapshot: { v: 2 } })
    })
  })
})
