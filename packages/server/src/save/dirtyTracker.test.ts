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

  /**
   * 코얼레싱은 값만 갱신하고 **최초 삽입 위치를 보존한다**(Map 의미론). drain 순서가 곧 write 시도
   * 순서이므로, 이 성질이 깨지면 "먼저 마킹한 키가 먼저 write된다"는 계약이 재-mark가 끼는 순간
   * 조용히 무너진다 — `save/saveEngine.ts` 헤더의 순서 계약이 이것에 기대고 있고, study 핸들러의
   * characters→objectDeletions 순서가 세션 종료의 characters 재-mark를 지나서도 살아남는 근거다.
   *
   * 이 사실을 여기서 고정하지 않으면 유일한 감시자가 실 소켓 e2e(가장 느리고 간접적인 층)가 된다.
   */
  it('재-mark는 값만 갱신하고 최초 삽입 위치를 유지한다(drain 순서 = write 시도 순서)', () => {
    tracker.markDirty('characters', 'char-1', { v: 1 })
    tracker.markDirty('objectDeletions', 'obj-9', { deleted: true })
    // characters 재-mark — 최신 삽입이라고 뒤로 밀리면 안 된다.
    tracker.markDirty('characters', 'char-1', { v: 2 })

    const drained = tracker.drain()

    expect(drained.map((e) => e.collection)).toEqual(['characters', 'objectDeletions'])
    expect(drained[0]?.snapshot).toEqual({ v: 2 })
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

  /**
   * checkout/ack/discard/peek 수명 계약.
   *
   * checkout은 registry를 비우면서 같은 엔트리를 inProgress로 이관해, 스냅샷이 mark 시점부터
   * write 종결(ack/discard)까지 tracker 안에 연속 존재하게 만든다. peek은 registry를 먼저 보고
   * 없을 때만 inProgress를 보므로, checkout 이후 재-mark된 최신 스냅샷이 항상 우선한다.
   *
   * ack과 discard는 같은 해제 규칙(참조 동일성)을 공유하므로 두 메서드를 같은 본문으로
   * 검증한다 — 한쪽만 고쳐도 다른 쪽이 통과하는 복제 케이스를 만들지 않기 위해서다.
   */
  describe('checkout/ack/discard/peek (수명 계약)', () => {
    const settleMethods = ['ack', 'discard'] as const

    it('checkout은 registry를 비우지만 peek은 이관된 동일 참조를 계속 반환한다', () => {
      const snapshot = { v: 1 }
      tracker.markDirty('characters', 'char-1', snapshot)

      const checked = tracker.checkout()

      expect(checked).toEqual([{ collection: 'characters', id: 'char-1', snapshot }])
      expect(tracker.size).toBe(0)
      expect(tracker.peek('characters', 'char-1')).toBe(checked[0])
    })

    /**
     * checkout 순서 = write 시도 순서.
     *
     * drain과 마찬가지로 checkout도 Map 삽입 순서를 그대로 내보내며, 재-mark는 값만 갱신하고
     * 최초 삽입 위치를 보존한다. flush가 이 배열 순서대로 enqueue하므로 이 성질이 깨지면
     * study 핸들러의 characters→objectDeletions 순서 계약이 조용히 무너진다. drain 쪽 동일
     * 케이스와 중복처럼 보이지만, flush 경로가 checkout으로 옮겨가면 이 케이스가 그 계약의
     * 유일한 단위 감시자가 된다.
     */
    it('checkout은 Map 삽입 순서를 보존한다(checkout 순서 = write 시도 순서)', () => {
      tracker.markDirty('characters', 'char-1', { v: 1 })
      tracker.markDirty('objectDeletions', 'obj-9', { deleted: true })
      // characters 재-mark — 최신 삽입이라고 뒤로 밀리면 안 된다.
      tracker.markDirty('characters', 'char-1', { v: 2 })

      const checked = tracker.checkout()

      expect(checked.map((e) => e.collection)).toEqual(['characters', 'objectDeletions'])
      expect(checked[0]?.snapshot).toEqual({ v: 2 })
    })

    it('checkout 후 같은 키를 재-mark하면 peek이 registry의 최신 값을 우선 반환한다', () => {
      tracker.markDirty('characters', 'char-1', { v: 1 })
      tracker.checkout()

      tracker.markDirty('characters', 'char-1', { v: 2 })

      expect(tracker.peek('characters', 'char-1')?.snapshot).toEqual({ v: 2 })
      expect(tracker.size).toBe(1)
      expect(tracker.inProgressSize).toBe(1)
    })

    it.each(settleMethods)('%s 후 peek이 undefined를 반환한다', (settle) => {
      tracker.markDirty('characters', 'char-1', { v: 1 })
      const [entry] = tracker.checkout()

      tracker[settle](entry!)

      expect(tracker.peek('characters', 'char-1')).toBeUndefined()
      expect(tracker.inProgressSize).toBe(0)
    })

    it.each(settleMethods)('%s은 같은 배치의 다른 키에 영향을 주지 않는다', (settle) => {
      tracker.markDirty('characters', 'char-1', { v: 1 })
      tracker.markDirty('characters', 'char-2', { v: 2 })
      const checked = tracker.checkout()

      tracker[settle](checked[0]!)

      expect(tracker.peek('characters', 'char-1')).toBeUndefined()
      expect(tracker.peek('characters', 'char-2')?.snapshot).toEqual({ v: 2 })
      expect(tracker.inProgressSize).toBe(1)
    })

    it('참조가 다른 엔트리로 ack·discard하면 no-op이다', () => {
      tracker.markDirty('characters', 'char-1', { v: 1 })
      const [entry] = tracker.checkout()
      // collection·id는 같고 참조만 다른 위조 엔트리 — 키가 아니라 참조가 해제 조건임을 고정한다.
      const impostor = { collection: 'characters', id: 'char-1', snapshot: { v: 1 } }

      tracker.ack(impostor)
      tracker.discard(impostor)

      expect(tracker.peek('characters', 'char-1')).toBe(entry)
      expect(tracker.inProgressSize).toBe(1)
    })

    it('inProgress에 없는 키를 ack·discard해도 throw하지 않는다', () => {
      const ghost = { collection: 'characters', id: 'ghost', snapshot: {} }

      expect(() => tracker.ack(ghost)).not.toThrow()
      expect(() => tracker.discard(ghost)).not.toThrow()
      expect(tracker.inProgressSize).toBe(0)
    })

    /**
     * 스펙 §8.6 — 해제의 참조 동일성 조건이 지키는 것.
     *
     * 키 K가 S1으로 in-flight인 동안 K가 S2로 재-mark되고 두 번째 checkout이 S2를 이관하면,
     * 뒤늦게 도착한 S1의 종결 통지가 inProgress의 K를 지워선 안 된다. 지우면 아직 write되지 않은
     * S2가 tracker에서 사라져 hydrate가 과거 문서를 읽는 진행도 revert가 재발한다.
     */
    it.each(settleMethods)(
      '§8.6: 재-checkout으로 S2가 이관된 뒤 도착한 S1의 %s는 S2를 지우지 않는다',
      (settle) => {
        const s2 = { v: 2 }
        tracker.markDirty('characters', 'char-1', { v: 1 })
        const [entry1] = tracker.checkout()

        tracker.markDirty('characters', 'char-1', s2)
        const [entry2] = tracker.checkout()

        tracker[settle](entry1!)

        expect(tracker.peek('characters', 'char-1')).toBe(entry2)
        expect(tracker.peek('characters', 'char-1')?.snapshot).toBe(s2)
        expect(tracker.inProgressSize).toBe(1)
      },
    )

    it('evict는 registry와 inProgress 양쪽에서 키를 제거한다', () => {
      // (a) checkout으로 inProgress에만 있는 상태
      tracker.markDirty('characters', 'char-1', { v: 1 })
      tracker.checkout()
      tracker.evict('characters', 'char-1')
      expect(tracker.peek('characters', 'char-1')).toBeUndefined()
      expect(tracker.inProgressSize).toBe(0)

      // (b) inProgress와 registry 양쪽에 있는 상태
      tracker.markDirty('characters', 'char-2', { v: 1 })
      tracker.checkout()
      tracker.markDirty('characters', 'char-2', { v: 2 })
      expect(tracker.size).toBe(1)
      expect(tracker.inProgressSize).toBe(1)

      tracker.evict('characters', 'char-2')

      expect(tracker.peek('characters', 'char-2')).toBeUndefined()
      expect(tracker.size).toBe(0)
      expect(tracker.inProgressSize).toBe(0)
    })

    it('두 번 연속 checkout은 서로소 집합을 반환한다', () => {
      tracker.markDirty('characters', 'char-1', { v: 1 })
      const first = tracker.checkout()

      const second = tracker.checkout()

      expect(first).toHaveLength(1)
      expect(second).toEqual([])

      tracker.markDirty('characters', 'char-2', { v: 2 })
      const third = tracker.checkout()

      expect(third.map((e) => e.id)).toEqual(['char-2'])
      expect(first.map((e) => e.id)).toEqual(['char-1'])
    })

    it('peek은 mark되지 않은 키에 undefined를 반환한다', () => {
      expect(tracker.peek('characters', 'ghost')).toBeUndefined()
    })

    it('inProgressSize는 checkout·ack에 따라 in-flight 개수를 반영한다', () => {
      expect(tracker.inProgressSize).toBe(0)

      tracker.markDirty('characters', 'char-1', {})
      tracker.markDirty('characters', 'char-2', {})
      expect(tracker.inProgressSize).toBe(0)

      const checked = tracker.checkout()
      expect(tracker.inProgressSize).toBe(2)
      expect(tracker.size).toBe(0)

      tracker.ack(checked[0]!)
      expect(tracker.inProgressSize).toBe(1)

      tracker.discard(checked[1]!)
      expect(tracker.inProgressSize).toBe(0)
    })
  })
})
