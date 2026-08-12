import { describe, it, expect, vi } from 'vitest'
import {
  createMarkObjectDeleted,
  OBJECT_DELETIONS_COLLECTION,
  type RawMarkDirty,
} from './markObjectDeleted.js'

/**
 * markObjectDeleted — objectDeletions 컬렉션 markDirty의 단일 계약 지점.
 *
 * 세 가지를 고정한다: (a) collection 리터럴이 `objectDeletions`이고 id가 그대로 전달된다,
 * (b) 스냅샷이 툼스톤(`{_id, deleted:true}`)이라 flush 로그에 삭제 의도가 남는다,
 * (c) objectId 형태 가드가 빈 문자열·비문자열을 markDirty에 도달하기 전에 막는다.
 * (c)가 깨지면 객체 id가 Mongo `_id` 필터에 실려 연산자 주입 표면이 열린다.
 */

/** 원시 markDirty seam을 spy로 두고 헬퍼를 감싼 하네스. */
function harness() {
  const markDirty = vi.fn<RawMarkDirty>()
  const markObjectDeleted = createMarkObjectDeleted(markDirty)
  return { markDirty, markObjectDeleted }
}

describe('createMarkObjectDeleted', () => {
  describe('markDirty 위임 형태', () => {
    it("collection은 'objectDeletions' 리터럴, id는 그대로 전달하고 1회만 호출한다", () => {
      const h = harness()

      h.markObjectDeleted('obj-9')

      expect(h.markDirty).toHaveBeenCalledTimes(1)
      expect(h.markDirty).toHaveBeenCalledWith('objectDeletions', 'obj-9', expect.anything())
    })

    it('컬렉션 상수를 리터럴과 동일하게 내보낸다(호출처 공유 단일 출처)', () => {
      expect(OBJECT_DELETIONS_COLLECTION).toBe('objectDeletions')
    })

    it('툼스톤 스냅샷 {_id, deleted:true}를 실어 로그 컨텍스트를 남긴다', () => {
      const h = harness()

      h.markObjectDeleted('obj-9')

      expect(h.markDirty.mock.calls[0]?.[2]).toEqual({ _id: 'obj-9', deleted: true })
    })

    it('호출마다 새 툼스톤 객체를 만든다(호출 간 별칭 공유 없음)', () => {
      const h = harness()

      h.markObjectDeleted('obj-1')
      h.markObjectDeleted('obj-2')

      expect(h.markDirty).toHaveBeenCalledTimes(2)
      expect(h.markDirty.mock.calls[0]?.[2]).not.toBe(h.markDirty.mock.calls[1]?.[2])
    })
  })

  describe('objectId 형태 가드', () => {
    it('빈 문자열 objectId를 거부하고 markDirty에 도달시키지 않는다', () => {
      const h = harness()

      expect(() => h.markObjectDeleted('')).toThrow()
      expect(h.markDirty).not.toHaveBeenCalled()
    })

    it('비문자열 objectId(연산자 객체)를 거부하고 markDirty에 도달시키지 않는다', () => {
      const h = harness()

      // Mongo `_id` 필터에 그대로 실리는 값이라 `{$ne:''}` 같은 연산자 객체가 유입되면
      // 임의 문서가 삭제 대상이 된다 — 진입점에서 형태를 강제한다(defense-in-depth).
      expect(() => h.markObjectDeleted({ $ne: '' } as unknown as string)).toThrow()
      expect(h.markDirty).not.toHaveBeenCalled()
    })

    it('null·undefined objectId를 거부한다', () => {
      const h = harness()

      expect(() => h.markObjectDeleted(null as unknown as string)).toThrow()
      expect(() => h.markObjectDeleted(undefined as unknown as string)).toThrow()
      expect(h.markDirty).not.toHaveBeenCalled()
    })
  })
})
