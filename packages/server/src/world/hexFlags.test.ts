import { describe, it, expect } from 'vitest'
import {
  F_ISSET,
  F_SET,
  F_CLR,
  MPERMT,
  MSCAVE,
  MHASSC,
  MBEFUD,
  MSUMMO,
  OPERMT,
  OHIDDN,
  OSCENE,
} from './hexFlags.js'

/**
 * hex string 비트 헬퍼 검증 — 원본 F_ISSET(flagsHex, bit): byte=parseInt(hex.substr((bit>>3)*2,2),16);
 * (byte>>(bit&7))&1. door.ts hasFlag는 number[]용이라 hex string용을 별도로 둔다.
 */
describe('F_ISSET — hex string 비트 조회', () => {
  it('좀도둑 flags 0112: MPERMT(bit0) 세팅, MSCAVE(bit11) 미세팅', () => {
    const flags = '0112000000000000' // byte0=0x01, byte1=0x12
    expect(F_ISSET(flags, MPERMT)).toBe(true)
    expect(F_ISSET(flags, MSCAVE)).toBe(false)
  })

  it('object flags 0300: OPERMT(bit0)·OHIDDN(bit1) 세팅', () => {
    const flags = '0300000000000000' // byte0=0x03
    expect(F_ISSET(flags, OPERMT)).toBe(true)
    expect(F_ISSET(flags, OHIDDN)).toBe(true)
    expect(F_ISSET(flags, OSCENE)).toBe(false)
  })

  it('상위 바이트 비트(MSUMMO=61, byte7)를 읽는다', () => {
    // byte7 = 0x20 = bit61 (61>>3=7, 61&7=5, 1<<5=0x20)
    const flags = '0000000000000020'
    expect(F_ISSET(flags, MSUMMO)).toBe(true)
  })

  it('빈/짧은 hex는 세팅 안 된 것으로 취급한다(안전 가드)', () => {
    expect(F_ISSET('', MPERMT)).toBe(false)
    expect(F_ISSET('01', MHASSC)).toBe(false)
  })
})

describe('F_SET / F_CLR — 새 hex string 반환(불변)', () => {
  it('F_SET은 지정 비트를 세팅한 새 문자열을 반환하고 입력을 변형하지 않는다', () => {
    const flags = '0000000000000000'
    const out = F_SET(flags, MHASSC) // bit18 → byte2 bit2 = 0x04
    expect(out).toBe('0000040000000000')
    expect(flags).toBe('0000000000000000') // 입력 불변
  })

  it('F_CLR은 지정 비트를 클리어한 새 문자열을 반환한다', () => {
    const flags = '0112000000000000'
    const out = F_CLR(flags, MPERMT) // byte0 0x01 → 0x00
    expect(out).toBe('0012000000000000')
    expect(F_ISSET(out, MPERMT)).toBe(false)
  })

  it('F_SET→F_ISSET 왕복이 성립한다(MBEFUD=51, byte6 bit3)', () => {
    const set = F_SET('0000000000000000', MBEFUD)
    expect(F_ISSET(set, MBEFUD)).toBe(true)
    expect(F_ISSET(F_CLR(set, MBEFUD), MBEFUD)).toBe(false)
  })

  it('짧은/빈 문자열에 고비트 세팅 시 zero-pad해 올바른 바이트에 기록한다(bit51, byte6)', () => {
    // 빈 문자열에 bit51(byte6)을 세팅한다. zero-pad 없으면 substring이 짧은 문자열
    // 전체를 반환해 고비트가 byte0에 잘못 실린다(플레이어 flags '' + F_SET 경로).
    const set = F_SET('', MBEFUD)
    expect(F_ISSET(set, MBEFUD)).toBe(true)
    // 낮은 비트로 오염되지 않는다(bit3은 byte0 bit3 — 오배치 시 참이 됐을 자리).
    expect(F_ISSET(set, 3)).toBe(false)
  })
})
