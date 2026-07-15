import { describe, it, expect } from 'vitest'
import type { ExitEdge } from 'shared'
import {
  hasFlag,
  setFlag,
  clearFlag,
  keyMatch,
  openexit,
  closeexit,
  lock,
  unlock,
  XLOCKD,
  XCLOSD,
  XLOCKS,
  XCLOSS,
  XNOSEE,
  KEY,
} from './door.js'

// 테스트용 출구 엣지 팩토리. flags는 4바이트(32비트) number[]로, 주어진 비트들을
// setFlag로 세팅해 초기 문 상태를 구성한다. ltime 기본값은 0(부팅 시 변경 없음).
function makeExit(bits: number[], key = 0, ltime = 0): ExitEdge {
  const flags = [0, 0, 0, 0]
  for (const bit of bits) setFlag(flags, bit)
  return {
    name: '문',
    targetRoomId: 100,
    flags,
    key,
    ltime,
    interval: 60,
  }
}

// 테스트용 열쇠 오브젝트(door 로컬 최소 shape). type=KEY(11)면 열쇠, ndice가 열쇠 ID.
function makeKey(ndice: number, shotscur = 3, type = KEY) {
  return { type, ndice, shotscur }
}

describe('hasFlag — F_ISSET 이식', () => {
  it('범위 밖 인덱스는 false를 반환한다(안전 가드)', () => {
    // XNOSEE(19)는 byte 2를 보는데 배열이 짧으면 flags[2]는 undefined → ?? 0으로 false.
    expect(hasFlag([0], XNOSEE)).toBe(false)
    expect(hasFlag([], XLOCKD)).toBe(false)
  })

  it('각 비트를 정확히 판정한다', () => {
    const flags = [0, 0, 0, 0]
    setFlag(flags, XLOCKD)
    expect(hasFlag(flags, XLOCKD)).toBe(true)
    expect(hasFlag(flags, XCLOSD)).toBe(false)
  })

  it('상위 바이트 비트(XNOSEE=19)를 판정한다', () => {
    const flags = [0, 0, 0, 0]
    setFlag(flags, XNOSEE)
    // XNOSEE=19 → byte 2(19>>3), mask 1<<3
    expect(flags[2]).toBe(8)
    expect(hasFlag(flags, XNOSEE)).toBe(true)
  })
})

describe('setFlag / clearFlag — 문 상태 in-place 변경', () => {
  it('setFlag는 해당 바이트에 비트를 세팅한다', () => {
    const flags = [0, 0, 0, 0]
    setFlag(flags, XCLOSD) // bit 3 → byte 0, mask 8
    expect(flags[0]).toBe(8)
  })

  it('clearFlag는 해당 비트만 해제한다', () => {
    const flags = [0, 0, 0, 0]
    setFlag(flags, XLOCKD) // bit 2, mask 4
    setFlag(flags, XCLOSD) // bit 3, mask 8
    clearFlag(flags, XLOCKD)
    expect(hasFlag(flags, XLOCKD)).toBe(false)
    expect(hasFlag(flags, XCLOSD)).toBe(true)
  })

  it('범위 밖 인덱스에서도 ?? 0 가드로 안전하게 동작한다', () => {
    const shortFlags = [0] // byte 1·2가 없는 짧은 배열
    setFlag(shortFlags, XNOSEE) // byte 2 세팅 → undefined ?? 0 경로
    expect(hasFlag(shortFlags, XNOSEE)).toBe(true)
    clearFlag([0], XNOSEE) // byte 2가 없는 배열에서 clear → undefined ?? 0 경로
    expect(hasFlag([0], XNOSEE)).toBe(false)
  })
})

describe('keyMatch — 숫자 매칭(이름 아님)', () => {
  it('type이 KEY가 아니면 거부한다', () => {
    const exit = makeExit([], 7)
    const notKey = makeKey(7, 3, 99) // type=99 (KEY 아님)
    expect(keyMatch(notKey, exit)).toBe(false)
  })

  it('ndice가 exit.key와 다르면 거부한다', () => {
    const exit = makeExit([], 7)
    const wrongKey = makeKey(8) // ndice=8 != exit.key=7
    expect(keyMatch(wrongKey, exit)).toBe(false)
  })

  it('type=KEY이고 ndice==exit.key면 true', () => {
    const exit = makeExit([], 7)
    const rightKey = makeKey(7)
    expect(keyMatch(rightKey, exit)).toBe(true)
  })
})

describe('openexit — XLOCKD 거부, 아니면 XCLOSD 해제 + ltime 리셋', () => {
  it('XLOCKD 출구는 거부하고 상태를 변경하지 않는다', () => {
    const exit = makeExit([XLOCKD, XCLOSD], 0, 5)
    const result = openexit(exit, 999)
    expect(result).toBe(false)
    // 거부 경로는 부수효과 없음: flags·ltime 불변
    expect(hasFlag(exit.flags, XCLOSD)).toBe(true)
    expect(exit.ltime).toBe(5)
  })

  it('비-XLOCKD 닫힌 출구는 XCLOSD 해제 + ltime 리셋 후 true', () => {
    const exit = makeExit([XCLOSD], 0, 5)
    const result = openexit(exit, 999)
    expect(result).toBe(true)
    expect(hasFlag(exit.flags, XCLOSD)).toBe(false)
    expect(exit.ltime).toBe(999)
  })
})

describe('closeexit — XCLOSS 능력 필요, XCLOSD 설정(ltime 불변)', () => {
  it('XCLOSS 능력이 없으면 거부하고 상태를 변경하지 않는다', () => {
    const exit = makeExit([], 0, 5)
    const result = closeexit(exit)
    expect(result).toBe(false)
    expect(hasFlag(exit.flags, XCLOSD)).toBe(false)
    expect(exit.ltime).toBe(5)
  })

  it('XCLOSS 능력이 있으면 XCLOSD를 설정한다(ltime 리셋 없음)', () => {
    const exit = makeExit([XCLOSS], 0, 5)
    const result = closeexit(exit)
    expect(result).toBe(true)
    expect(hasFlag(exit.flags, XCLOSD)).toBe(true)
    // closeexit는 타이머를 리셋하지 않는다
    expect(exit.ltime).toBe(5)
  })
})

describe('lock — XLOCKS + XCLOSD + 열쇠일치 전부 요구(ltime 불변)', () => {
  const key = makeKey(7)

  it('XLOCKS 능력이 없으면 거부한다', () => {
    const exit = makeExit([XCLOSD], 7)
    expect(lock(exit, key)).toBe(false)
    expect(hasFlag(exit.flags, XLOCKD)).toBe(false)
  })

  it('XCLOSD(먼저 닫힘)가 아니면 거부한다', () => {
    const exit = makeExit([XLOCKS], 7) // 능력은 있지만 닫혀있지 않음
    expect(lock(exit, key)).toBe(false)
    expect(hasFlag(exit.flags, XLOCKD)).toBe(false)
  })

  it('열쇠가 일치하지 않으면 거부한다', () => {
    const exit = makeExit([XLOCKS, XCLOSD], 7)
    const wrongKey = makeKey(8)
    expect(lock(exit, wrongKey)).toBe(false)
    expect(hasFlag(exit.flags, XLOCKD)).toBe(false)
  })

  it('세 조건 충족 시 XLOCKD 설정(ltime 리셋 없음)', () => {
    const exit = makeExit([XLOCKS, XCLOSD], 7, 5)
    const result = lock(exit, key)
    expect(result).toBe(true)
    expect(hasFlag(exit.flags, XLOCKD)).toBe(true)
    // lock은 타이머를 리셋하지 않는다(openexit/unlock만 리셋)
    expect(exit.ltime).toBe(5)
  })
})

describe('unlock — XLOCKD + 열쇠 요구, 성공 시 해제 + shotscur 감소 + ltime 리셋', () => {
  it('XLOCKD가 아니면 거부한다', () => {
    const exit = makeExit([], 7, 5)
    const key = makeKey(7, 3)
    const result = unlock(exit, key, 999)
    expect(result).toBe(false)
    expect(key.shotscur).toBe(3)
    expect(exit.ltime).toBe(5)
  })

  it('열쇠가 일치하지 않으면 거부하고 shotscur·ltime 불변', () => {
    const exit = makeExit([XLOCKD], 7, 5)
    const wrongKey = makeKey(8, 3)
    const result = unlock(exit, wrongKey, 999)
    expect(result).toBe(false)
    expect(hasFlag(exit.flags, XLOCKD)).toBe(true)
    expect(wrongKey.shotscur).toBe(3)
    expect(exit.ltime).toBe(5)
  })

  it('XLOCKD + 열쇠 일치 시 해제 + shotscur-- + ltime 리셋', () => {
    const exit = makeExit([XLOCKD], 7, 5)
    const key = makeKey(7, 3)
    const result = unlock(exit, key, 999)
    expect(result).toBe(true)
    expect(hasFlag(exit.flags, XLOCKD)).toBe(false)
    expect(key.shotscur).toBe(2)
    expect(exit.ltime).toBe(999)
  })
})
