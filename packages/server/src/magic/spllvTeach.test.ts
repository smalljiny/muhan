import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { approve, goldenFixtureSchema } from 'shared'
import { canTeachSpllv } from './learning.js'

/**
 * spllv 전수등급 골든 fixture approve — magic1.c:212-235 spllv 5-if 체인 대조.
 *
 * anti-tautology: fixture expected는 spllvTeachFixture.ts의 magic1.c 독립 전사(oracleCanTeachSpllv),
 * SUT는 server/magic/learning.ts의 canTeachSpllv 구현. 두 전사가 diff되면 approve가 throw한다.
 * 완료 기준 "spllv 전수등급 fixture가 server 테스트에서 approve"에 맞춰 server가 디스크 json을 읽어
 * shared SUT로 실행한다(mprofic.json·spellStore.json 선례 — fixture는 shared 소유, SUT 소비 approve는 server).
 */
describe('체크인된 spllv_teach.json 골든 fixture', () => {
  const loadFixture = () => {
    const url = new URL('../../../shared/src/oracle/fixtures/spllv_teach.json', import.meta.url)
    const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
    const result = goldenFixtureSchema.safeParse(parsed)
    expect(result.success).toBe(true)
    if (!result.success) throw new Error('spllv_teach.json 스키마 실패')
    return result.data as Parameters<typeof approve>[0]
  }

  it('goldenFixtureSchema를 통과하고 manual oracle이다', () => {
    const fixture = loadFixture()
    expect(fixture.oracle.method).toBe('manual')
    expect(fixture.cases.length).toBeGreaterThan(0)
  })

  it('approve가 canTeachSpllv SUT로 전 케이스를 throw 없이 통과한다', () => {
    const fixture = loadFixture()
    const sut = (input: unknown): unknown => {
      const c = input as { class: number; spllv: number }
      return canTeachSpllv(c.class, c.spllv)
    }
    expect(() => approve(fixture, sut)).not.toThrow()
  })
})
