import { describe, it, expect } from 'vitest'
import { F_SET, orFlags, PHIDDN, PDMINV, PINVIS } from './hexFlags.js'
import { isPresenceAnnounced, type PresenceChange } from './presence.js'

/**
 * announce 판정 표 테스트 — 원본 메시지 억제 규칙(spec §3.3 판정 표).
 *
 * - moved-out: PDMINV일 때만 억제 (퇴장은 은신을 억제하지 않는 as-shipped 비대칭)
 * - moved-in·entered: PDMINV 또는 PHIDDN이면 억제
 * - exited: 원본에 방 메시지가 없어 항상 억제
 */
const NONE = ''
const HIDDEN = F_SET('', PHIDDN)
const DMINV = F_SET('', PDMINV)
const BOTH = orFlags(HIDDEN, DMINV)

type Row = readonly [PresenceChange, string, string, boolean]

const table: readonly Row[] = [
  ['moved-out', 'none', NONE, true],
  ['moved-out', 'PHIDDN', HIDDEN, true],
  ['moved-out', 'PDMINV', DMINV, false],
  ['moved-out', 'PHIDDN|PDMINV', BOTH, false],
  ['moved-in', 'none', NONE, true],
  ['moved-in', 'PHIDDN', HIDDEN, false],
  ['moved-in', 'PDMINV', DMINV, false],
  ['moved-in', 'PHIDDN|PDMINV', BOTH, false],
  ['entered', 'none', NONE, true],
  ['entered', 'PHIDDN', HIDDEN, false],
  ['entered', 'PDMINV', DMINV, false],
  ['entered', 'PHIDDN|PDMINV', BOTH, false],
  ['exited', 'none', NONE, false],
  ['exited', 'PHIDDN', HIDDEN, false],
  ['exited', 'PDMINV', DMINV, false],
  ['exited', 'PHIDDN|PDMINV', BOTH, false],
]

describe('isPresenceAnnounced', () => {
  it('표는 4 변화 × 4 플래그 조합 16행을 모두 담는다', () => {
    expect(table).toHaveLength(16)
  })

  it.each(table)('%s · 플래그 %s → announce %s', (change, _label, flags, expected) => {
    expect(isPresenceAnnounced(flags, change)).toBe(expected)
  })

  it.each<readonly [PresenceChange, boolean]>([
    ['moved-out', true],
    ['moved-in', true],
    ['entered', true],
    ['exited', false],
  ])('무관 비트 PINVIS만 켜진 hex는 %s를 억제하지 않는다 (exited 제외)', (change, expected) => {
    expect(isPresenceAnnounced(F_SET('', PINVIS), change)).toBe(expected)
  })
})
