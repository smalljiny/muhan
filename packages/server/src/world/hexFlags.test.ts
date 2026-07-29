import { describe, it, expect } from 'vitest'
import {
  F_ISSET,
  F_SET,
  F_CLR,
  orFlags,
  MPERMT,
  MSCAVE,
  MHASSC,
  MBEFUD,
  MSUMMO,
  OPERMT,
  OHIDDN,
  OSCENE,
  PBLIND,
  PFEARS,
  PSILNC,
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

/**
 * P-flag 비트 번호 고정 — `help/pflags` 문서 값(PBLIND 43·PFEARS 44·PSILNC 45)은 raw `#define`보다
 * +1이라 mtype.h를 정본으로 채택했다(hexFlags.ts 상단 주석). 세 비트는 전부 byte 5를 공유하므로
 * off-by-one이 들어오면 투영·절단 검증이 조용히 어긋난다. 소유 모듈에서 수치를 pin한다.
 */
describe('P-flag 비트 번호 — mtype.h 정본', () => {
  it('PBLIND=42 · PFEARS=43 · PSILNC=44 (전부 byte 5)', () => {
    expect(PBLIND).toBe(42)
    expect(PFEARS).toBe(43)
    expect(PSILNC).toBe(44)
    expect([PBLIND, PFEARS, PSILNC].map((b) => b >> 3)).toEqual([5, 5, 5])
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

/**
 * orFlags 폭 보존 검증 — 8바이트(16자) 고정 순회가 정본이다. `Math.min(a.length, b.length)`로
 * 순회하면 짧은 피연산자가 결과 폭을 결정해 긴 쪽의 고바이트가 절단된다. PBLIND(42)·PFEARS(43)·
 * PSILNC(44)는 전부 byte5(문자 인덱스 10-11)라 절단에 정확히 걸리는 회귀 탐지 비트다.
 */
describe('orFlags — 폭 보존 hex OR', () => {
  it('양쪽 16자 입력을 바이트 단위로 OR하고 16자를 반환한다', () => {
    const out = orFlags('0112000000000000', '0000040000000000')
    expect(out).toBe('0112040000000000')
    expect(out.length).toBe(16)
  })

  it('한쪽이 빈 문자열이면 다른 쪽을 그대로 살린 16자를 반환한다', () => {
    const out = orFlags('0112000000000000', '')
    expect(out).toBe('0112000000000000')
    expect(out.length).toBe(16)
  })

  it('양쪽이 빈 문자열이면 0으로 채운 16자를 반환한다', () => {
    const out = orFlags('', '')
    expect(out).toBe('0000000000000000')
    expect(out.length).toBe(16)
  })

  it('한쪽이 4자(짧은 피연산자)여도 고바이트를 절단하지 않는다', () => {
    // 긴 쪽 byte5 = 0x1c = bit42|bit43|bit44 (PBLIND·PFEARS·PSILNC).
    // Math.min 순회 구현은 여기서 '00ff'(4자)로 잘려 세 비트를 모두 잃는다.
    const out = orFlags('00000000001c0000', '00ff')
    expect(out).toBe('00ff0000001c0000')
    expect(out.length).toBe(16)
    expect(F_ISSET(out, PBLIND)).toBe(true)
    expect(F_ISSET(out, PFEARS)).toBe(true)
    expect(F_ISSET(out, PSILNC)).toBe(true)
  })

  it('짧은 피연산자가 앞에 와도(인자 순서 무관) 폭과 비트가 보존된다', () => {
    const out = orFlags('00ff', '00000000001c0000')
    expect(out).toBe('00ff0000001c0000')
    expect(out.length).toBe(16)
    expect(F_ISSET(out, PSILNC)).toBe(true)
  })

  it('양쪽에 겹쳐 세팅된 비트를 OR한다(XOR 아님)', () => {
    // byte1: 0xff | 0xf0 = 0xff (XOR이면 0x0f), byte5: 0x1c | 0x1c = 0x1c (XOR이면 0x00).
    // 세 투영 출처의 비트 집합은 오늘 서로소라 상위 Story가 겹침 입력을 만들지 않는다 —
    // OR/XOR 구별은 이 단위 케이스가 유일한 방어선이다.
    const out = orFlags('00ff0000001c0000', '00f00000001c0000')
    expect(out).toBe('00ff0000001c0000')
    expect(F_ISSET(out, PSILNC)).toBe(true)
  })

  it('대문자 hex 입력을 소문자 16자로 정규화한다', () => {
    // 저장소 관행상 flags hex는 문자열 동등성으로 단정된다(worldGraph.test.ts 등) —
    // 소문자 정규화는 JSDoc이 명시하는 계약이므로 테스트로 고정한다.
    expect(orFlags('00FF', '')).toBe('00ff000000000000')
  })

  it('두 입력 문자열을 변형하지 않는다(순수 함수)', () => {
    const a = '00000000001c0000'
    const b = '00ff'
    orFlags(a, b)
    expect(a).toBe('00000000001c0000')
    expect(b).toBe('00ff')
  })
})
