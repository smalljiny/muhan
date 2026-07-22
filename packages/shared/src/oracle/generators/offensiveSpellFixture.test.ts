import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { goldenFixtureSchema } from '../types.js'
import { buildCases, buildFixture, writeFixtureFile } from './offensiveSpellFixture.js'

const FIXED_CLOCK = (): Date => new Date('2026-07-16T00:00:00.000Z')

describe('offensiveSpellFixture — buildCases 독립 전사 앵커', () => {
  it('각 case의 rolls 길이가 osp.ndice와 일치한다(dice 굴림 개수 계약)', () => {
    for (const c of buildCases()) {
      expect(c.input.rolls.length).toBe(c.input.osp.ndice)
    }
  })

  it('대표 앵커 값이 magic1.c 공식과 일치한다', () => {
    const byNote = new Map(buildCases().map((c) => [c.note, c]))
    expect(byNote.get('tier1 1d8+0: dmg=6')?.expected.dmg).toBe(6)
    expect(byNote.get('tier2 2d5+7: dmg=14')?.expected.dmg).toBe(14)
    expect(byNote.get('tier5 4d5+30: dmg=44')?.expected.dmg).toBe(44)
    expect(byNote.get('방 상성 동속성 ×2: bns=12, dmg=26')?.expected.dmg).toBe(26)
    expect(byNote.get('방 상성 반대속성 약화: bns=-6, dmg=8')?.expected.dmg).toBe(8)
    expect(byNote.get('max(1) floor: bns=-5, dmg=1')?.expected.dmg).toBe(1)
    expect(byNote.get('마법저항 50% 감산: dmg 14→7')?.expected.dmg).toBe(7)
    expect(byNote.get('마법저항 완전무효: dmg 14→0, hp 불변')?.expected.dmg).toBe(0)
  })

  it('사망 케이스: 오버킬 캡·death 발화·ledger가 정확하다', () => {
    const byNote = new Map(buildCases().map((c) => [c.note, c]))
    const kill = byNote.get('creature 사망 + 오버킬 캡: m=5, finalHp=-9, deathFires=1')
    expect(kill?.expected).toEqual({ dmg: 14, finalHp: -9, died: true, ledgerAmount: 5, deathFires: 1 })
    const playerKill = byNote.get('player 사망: ledger 0, deathFires=1')
    expect(playerKill?.expected.ledgerAmount).toBe(0)
    expect(playerKill?.expected.deathFires).toBe(1)
    const playerLive = byNote.get('player 생존: dmg=14, ledger 0')
    expect(playerLive?.expected.ledgerAmount).toBe(0)
    expect(playerLive?.expected.died).toBe(false)
  })
})

describe('offensiveSpellFixture — buildFixture', () => {
  it('goldenFixtureSchema를 통과하고 fn/method가 맞다', () => {
    const fixture = buildFixture(FIXED_CLOCK)
    expect(goldenFixtureSchema.safeParse(fixture).success).toBe(true)
    expect(fixture.fn).toBe('offensive_spell')
    expect(fixture.oracle.method).toBe('manual')
  })

  it('generatedAt이 주입 clock으로 결정적이다', () => {
    expect(buildFixture(FIXED_CLOCK).oracle.generatedAt).toBe('2026-07-16T00:00:00.000Z')
  })
})

describe('offensiveSpellFixture — writeFixtureFile', () => {
  it('pretty JSON을 기록하고 재로드 시 스키마를 통과한다', () => {
    const path = join(tmpdir(), `offensive_spell.test.${process.pid}.json`)
    try {
      writeFixtureFile(path, buildFixture(FIXED_CLOCK))
      const raw = readFileSync(path, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      expect(goldenFixtureSchema.safeParse(parsed).success).toBe(true)
    } finally {
      rmSync(path, { force: true })
    }
  })
})

describe('체크인된 offensive_spell.json fixture', () => {
  it('goldenFixtureSchema를 통과하고 manual oracle이다', () => {
    const url = new URL('../fixtures/offensive_spell.json', import.meta.url)
    const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
    const result = goldenFixtureSchema.safeParse(parsed)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.cases.length).toBeGreaterThan(0)
      expect(result.data.oracle.method).toBe('manual')
    }
  })
})
