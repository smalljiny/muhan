import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { approve, goldenFixtureSchema } from 'shared'
import { MAGE, CLERIC, PALADIN, RANGER, INVINCIBLE, CARETAKER, SUB_DM, DM, FIGHTER } from '../combat/constants.js'
import { mprofic } from './mprofic.js'

/**
 * mprofic 숙련 환산 단위 테스트 — player.c:1204-1261 정본.
 * realm[index-1] 원시경험치 → prof_array[12] 임계 → 0-110 백분율. 정수 나눗셈=Math.trunc, 엄격 <.
 */
describe('mprofic', () => {
  it('realm=0이면 어느 클래스든 prof=0이다(전 몬스터 realm=0)', () => {
    expect(mprofic(MAGE, [0, 0, 0, 0], 1)).toBe(0)
    expect(mprofic(CLERIC, [0, 0, 0, 0], 2)).toBe(0)
    expect(mprofic(FIGHTER, [0, 0, 0, 0], 3)).toBe(0)
  })

  it('엄격 < 경계: n==prof_array[1](1024)이면 i=1, prof=10+0', () => {
    // 1024 < prof_array[1]=1024 는 거짓(엄격 <) → i=1에서 break, 분수항 0.
    expect(mprofic(MAGE, [1024, 0, 0, 0], 1)).toBe(10)
  })

  it('MAGE 중간대역 보간: realm=3072 → i=2, prof=20+trunc((3072-2048)*10/(4096-2048))=25', () => {
    expect(mprofic(MAGE, [3072, 0, 0, 0], 1)).toBe(25)
  })

  it('정수 나눗셈(trunc) 분수항: MAGE realm=5000 → i=3, prof=30+trunc(9040/4096)=32', () => {
    expect(mprofic(MAGE, [5000, 0, 0, 0], 1)).toBe(32)
  })

  it('CLERIC 전용 테이블(prof_array[2]=4092): realm=4092 → i=2, prof=20', () => {
    expect(mprofic(CLERIC, [4092, 0, 0, 0], 1)).toBe(20)
  })

  it('PALADIN/RANGER 전용 테이블(prof_array[2]=8192): realm=8192 → i=2, prof=20', () => {
    expect(mprofic(PALADIN, [8192, 0, 0, 0], 1)).toBe(20)
    expect(mprofic(RANGER, [8192, 0, 0, 0], 1)).toBe(20)
  })

  it('default 테이블(prof_array[2]=40000): FIGHTER realm=40000 → i=2, prof=20', () => {
    expect(mprofic(FIGHTER, [40000, 0, 0, 0], 1)).toBe(20)
  })

  it('INVINCIBLE/CARETAKER/SUB_DM/DM은 MAGE 계열과 동일 테이블', () => {
    expect(mprofic(INVINCIBLE, [3072, 0, 0, 0], 1)).toBe(25)
    expect(mprofic(CARETAKER, [3072, 0, 0, 0], 1)).toBe(25)
    expect(mprofic(SUB_DM, [3072, 0, 0, 0], 1)).toBe(25)
    expect(mprofic(DM, [3072, 0, 0, 0], 1)).toBe(25)
  })

  it('index가 realm[index-1] 슬롯을 선택한다', () => {
    expect(mprofic(MAGE, [0, 3072, 0, 0], 2)).toBe(25)
    expect(mprofic(MAGE, [0, 0, 0, 3072], 4)).toBe(25)
  })

  it('OOB port 결정: n>=prof_array[11](5억)이면 prof=110 clamp(오라클 UB 구간)', () => {
    expect(mprofic(MAGE, [500000000, 0, 0, 0], 1)).toBe(110)
    expect(mprofic(MAGE, [999999999, 0, 0, 0], 1)).toBe(110)
  })
})

describe('체크인된 mprofic.json 골든 fixture', () => {
  // 크로스 패키지 읽기: fixture는 shared 소유, SUT mprofic은 server 소유(shared는 server를 import 못 함).
  // readFileSync로 디스크 데이터를 읽어 approve의 SUT만 server에서 소비한다(spell_fail.json 선례).
  const loadFixture = () => {
    const url = new URL('../../../shared/src/oracle/fixtures/mprofic.json', import.meta.url)
    const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
    const result = goldenFixtureSchema.safeParse(parsed)
    expect(result.success).toBe(true)
    if (!result.success) throw new Error('mprofic.json 스키마 실패')
    return result.data as Parameters<typeof approve>[0]
  }

  it('goldenFixtureSchema를 통과하고 manual oracle이다', () => {
    const fixture = loadFixture()
    expect(fixture.oracle.method).toBe('manual')
    expect(fixture.cases.length).toBeGreaterThan(0)
  })

  it('approve가 mprofic SUT로 전 케이스를 throw 없이 통과한다', () => {
    // anti-tautology: fixture expected는 mproficFixture.ts의 player.c 독립 전사(oracleMprofic),
    // SUT mprofic은 mprofic.ts 구현. 두 전사가 diff되면 approve가 throw한다.
    const fixture = loadFixture()
    const sut = (input: unknown): unknown => {
      const c = input as { class: number; realm: number[]; index: number }
      return mprofic(c.class, c.realm, c.index)
    }
    expect(() => approve(fixture, sut)).not.toThrow()
  })
})
