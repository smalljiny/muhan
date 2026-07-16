import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import type { ExitEdge } from 'shared'
import { intInRangeArb } from 'shared/property/arbitraries.testutil'
import {
  hasFlag,
  setFlag,
  openexit,
  closeexit,
  lock,
  unlock,
  XLOCKD,
  XCLOSD,
  XLOCKS,
  XCLOSS,
  KEY,
  type KeyLike,
} from './door.js'

/**
 * 문 상태머신 property 테스트 — 네 전이 함수(openexit/closeexit/lock/unlock)의 totality와
 * 성공 경로 사후 불변식을 fast-check로 실증한다.
 *
 * 비-vacuity 설계(advisor 지침):
 *   - totality: 임의 flags·key·now에서 항상 함수를 호출하므로 구조적으로 비-vacuous
 *     (모든 실행이 SUT를 구동, boolean 반환·무예외를 단정).
 *   - lock 성공 사후조건: lock은 XLOCKS ∧ XCLOSD ∧ keyMatch 3중 결합에서만 true라
 *     완전 임의 입력이면 거의 발화하지 않는다(vacuous 함정). 성공-적격 fixture를
 *     구성해 result===true를 **무조건** 단정 → 성공 분기를 항상 관측한다.
 *
 * in-place mutation 주의: 전이 함수는 exit.flags를 in-place 변경하므로 각 property 실행마다
 * 새 ExitEdge fixture를 만든다(공유 금지). 사후조건 관측 시 실행 전 상태는 호출 전에 캡처한다.
 */

// 지정 비트를 setFlag로 세팅한 fresh ExitEdge를 만든다(4바이트 flags, 매 호출 새 배열).
function makeExit(bits: number[], key: number, ltime: number): ExitEdge {
  const flags = [0, 0, 0, 0]
  for (const bit of bits) setFlag(flags, bit)
  return { name: '문', targetRoomId: 100, flags, key, ltime, interval: 60 }
}

// 상태·능력 비트의 임의 부분집합 arbitrary. setFlag로 조합해 임의 문 상태를 만든다.
const flagBitsArb = fc.subarray([XLOCKD, XCLOSD, XLOCKS, XCLOSS])

// 임의 열쇠 arbitrary. type은 KEY(11) 또는 비-KEY, ndice·shotscur는 범위 정수.
const keyArb: fc.Arbitrary<KeyLike> = fc.record({
  type: fc.constantFrom(KEY, 0, 99),
  ndice: intInRangeArb(0, 15),
  shotscur: intInRangeArb(0, 5),
})

const nowArb = intInRangeArb(0, 100000)
const keyIdArb = intInRangeArb(0, 15)

describe('door 전이 — totality (임의 flags·key·now, 무예외 boolean)', () => {
  it('openexit는 임의 입력에서 boolean을 반환하고 예외를 던지지 않는다', () => {
    fc.assert(
      fc.property(flagBitsArb, keyIdArb, nowArb, (bits, keyId, now) => {
        const exit = makeExit(bits, keyId, 0)
        expect(typeof openexit(exit, now)).toBe('boolean')
      }),
    )
  })

  it('closeexit는 임의 입력에서 boolean을 반환하고 예외를 던지지 않는다', () => {
    fc.assert(
      fc.property(flagBitsArb, keyIdArb, (bits, keyId) => {
        const exit = makeExit(bits, keyId, 0)
        expect(typeof closeexit(exit)).toBe('boolean')
      }),
    )
  })

  it('lock는 임의 flags·key에서 boolean을 반환하고 예외를 던지지 않는다', () => {
    fc.assert(
      fc.property(flagBitsArb, keyIdArb, keyArb, (bits, keyId, key) => {
        const exit = makeExit(bits, keyId, 0)
        expect(typeof lock(exit, key)).toBe('boolean')
      }),
    )
  })

  it('unlock는 임의 flags·key·now에서 boolean을 반환하고 예외를 던지지 않는다', () => {
    fc.assert(
      fc.property(flagBitsArb, keyIdArb, keyArb, nowArb, (bits, keyId, key, now) => {
        const exit = makeExit(bits, keyId, 0)
        expect(typeof unlock(exit, key, now)).toBe('boolean')
      }),
    )
  })
})

describe('door 전이 — 성공 경로 사후 불변식', () => {
  it('openexit 성공(true) ⇒ 실행 후 XCLOSD 해제됨 (임의 flags, 조건부 관측)', () => {
    // 임의 flags에서 XLOCKD 없는 조합이 ~절반이라 openexit가 자주 성공한다(비-vacuous).
    fc.assert(
      fc.property(flagBitsArb, keyIdArb, nowArb, (bits, keyId, now) => {
        const exit = makeExit(bits, keyId, 0)
        if (openexit(exit, now)) {
          expect(hasFlag(exit.flags, XCLOSD)).toBe(false)
        }
      }),
    )
  })

  it('openexit 성공-보장 fixture ⇒ result===true + XCLOSD 해제 + ltime 리셋', () => {
    // 성공-적격 fixture: XLOCKD 미세팅(openexit은 XLOCKD면 거부, 아니면 항상 성공).
    // 다른 능력 비트(XCLOSS)와 XCLOSD 선행 여부만 임의화한다. lock/unlock과 대칭으로
    // result===true를 **무조건** 단정 → openexit 성공 분기가 total-failure로 붕괴하면
    // 조건부 property와 달리 이 property가 실패해 회귀를 잡는다.
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), keyIdArb, nowArb, (withClosd, withCloss, keyId, now) => {
        const bits: number[] = []
        if (withClosd) bits.push(XCLOSD)
        if (withCloss) bits.push(XCLOSS)
        const exit = makeExit(bits, keyId, 0)
        const result = openexit(exit, now)
        expect(result).toBe(true) // 성공 분기 항상 관측 — vacuous 방지
        expect(hasFlag(exit.flags, XCLOSD)).toBe(false) // 사후: 열림
        expect(exit.ltime).toBe(now) // 타이머 리셋
      }),
    )
  })

  it('lock 성공(true) ⇒ 실행 전 XCLOSD가 선행 세팅돼 있었다', () => {
    // 성공-적격 fixture: XLOCKS+XCLOSD 세팅, 열쇠 type=KEY·ndice==exit.key. 다른 차원
    // (extra XLOCKD, key.shotscur, now)만 임의화한다. lock는 XLOCKD를 검사하지 않으므로
    // 이 fixture는 항상 성공해야 한다 → result===true를 무조건 단정(성공 분기 항상 관측).
    fc.assert(
      fc.property(
        fc.boolean(),
        keyIdArb,
        intInRangeArb(0, 5),
        (withLockd, keyId, shotscur) => {
          const bits = withLockd ? [XLOCKS, XCLOSD, XLOCKD] : [XLOCKS, XCLOSD]
          const exit = makeExit(bits, keyId, 0)
          const key: KeyLike = { type: KEY, ndice: keyId, shotscur }
          // 실행 전 XCLOSD 상태를 캡처(사후조건 비교 기준).
          const closedBefore = hasFlag(exit.flags, XCLOSD)
          const result = lock(exit, key)
          expect(result).toBe(true) // 성공 분기 항상 관측 — vacuous 방지
          expect(closedBefore).toBe(true) // lock 성공 ⇒ 선행 XCLOSD
          expect(hasFlag(exit.flags, XLOCKD)).toBe(true) // 사후: 잠김 세팅
        },
      ),
    )
  })

  it('unlock 성공(true) ⇒ XLOCKD 해제 + key.shotscur 감소 + ltime 리셋', () => {
    // 성공-적격 fixture: XLOCKD 세팅, 열쇠 일치. 성공 분기 항상 관측.
    fc.assert(
      fc.property(keyIdArb, intInRangeArb(1, 5), nowArb, (keyId, shotscur, now) => {
        const exit = makeExit([XLOCKD], keyId, 0)
        const key: KeyLike = { type: KEY, ndice: keyId, shotscur }
        const result = unlock(exit, key, now)
        expect(result).toBe(true)
        expect(hasFlag(exit.flags, XLOCKD)).toBe(false)
        expect(key.shotscur).toBe(shotscur - 1)
        expect(exit.ltime).toBe(now)
      }),
    )
  })
})
