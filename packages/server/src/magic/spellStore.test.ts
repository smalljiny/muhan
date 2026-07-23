import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { approve, emptySpellStore, goldenFixtureSchema, isKnown, setKnown } from 'shared'

/**
 * spell store 골든 fixture approve — mtype.h:570-571 S_ISSET/S_SET 비트 레이아웃 대조.
 *
 * anti-tautology: fixture expected는 spellStoreFixture.ts의 mtype.h 독립 전사(oracleKnownAfterSet),
 * SUT는 shared/magic/spellStore.ts의 isKnown/setKnown 구현. 두 전사가 diff되면 approve가 throw한다.
 * 완료 기준 "server 테스트에서 approve"에 맞춰 server가 디스크 json을 읽어 shared SUT로 실행한다
 * (mprofic.json 선례 — fixture는 shared 소유, SUT 소비 approve는 server가 소유).
 */
describe('체크인된 spellStore.json 골든 fixture', () => {
  const loadFixture = () => {
    const url = new URL('../../../shared/src/oracle/fixtures/spellStore.json', import.meta.url)
    const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
    const result = goldenFixtureSchema.safeParse(parsed)
    expect(result.success).toBe(true)
    if (!result.success) throw new Error('spellStore.json 스키마 실패')
    return result.data as Parameters<typeof approve>[0]
  }

  it('goldenFixtureSchema를 통과하고 manual oracle이다', () => {
    const fixture = loadFixture()
    expect(fixture.oracle.method).toBe('manual')
    expect(fixture.cases.length).toBeGreaterThan(0)
  })

  it('approve가 isKnown/setKnown SUT로 전 케이스를 throw 없이 통과한다', () => {
    const fixture = loadFixture()
    const sut = (input: unknown): unknown => {
      const c = input as { setBits: number[]; queryBit: number }
      let store = emptySpellStore()
      for (const b of c.setBits) store = setKnown(store, b)
      return isKnown(store, c.queryBit)
    }
    expect(() => approve(fixture, sut)).not.toThrow()
  })
})
