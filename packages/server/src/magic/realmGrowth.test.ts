import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import {
  approve,
  goldenFixtureSchema,
  type CreatureInstance,
  type RoomNode,
} from 'shared'
import { realmGrowthAmount } from './realmGrowth.js'
import { distributeCreatureDeath } from '../combat/deathDistribution.js'
import { createDamageLedger } from '../combat/enmity.js'

/**
 * realmGrowthAmount 단위 테스트 — realm 숙련 성장량 순수식(magic1.c:1122-1130, A6 §5).
 *   addrealm = MIN(trunc((m*exp)/MAX(1,hpmax)), exp)
 * delta(number)만 반환한다(deathDistribution expdiv 선례 충실). PvE 가드·realm 슬롯 적용은 호출자·#99 소관.
 */
describe('realmGrowthAmount — realm 성장량 공식', () => {
  it('growth=MIN(trunc(m*exp/hpmax), exp)', () => {
    // m=15, exp=100, hpmax=30 → trunc(1500/30)=50, MIN(50,100)=50.
    expect(realmGrowthAmount(15, 100, 30)).toBe(50)
  })

  it('trunc 절삭(정수 나눗셈)', () => {
    // m=7, exp=10, hpmax=30 → 2.33 → trunc 2.
    expect(realmGrowthAmount(7, 10, 30)).toBe(2)
  })

  it('exp 캡: trunc(m*exp/hpmax) > exp 이면 exp로 캡(MIN)', () => {
    // 방어적 케이스(m>hpmax): m=60, exp=10, hpmax=30 → trunc(600/30)=20, MIN(20,10)=10.
    expect(realmGrowthAmount(60, 10, 30)).toBe(10)
  })

  it('hpmax=0 → MAX(1,hpmax) 0분모 가드', () => {
    // m=5, exp=10, hpmax=0 → MAX(1,0)=1 → trunc(50/1)=50, MIN(50,10)=10.
    expect(realmGrowthAmount(5, 10, 0)).toBe(10)
  })

  it('exp=0 몬스터 → growth 0', () => {
    expect(realmGrowthAmount(15, 0, 30)).toBe(0)
  })

  it('m==hpmax 경계: trunc(exp) 그대로', () => {
    // m=30, exp=40, hpmax=30 → trunc(1200/30)=40, MIN(40,40)=40.
    expect(realmGrowthAmount(30, 40, 30)).toBe(40)
  })
})

// ── T4.3 addrealm 골든 fixture 소비 + combat exp 분배 동형(Criterion 5) ────────
interface RealmGrowthCaseInput {
  m: number
  exp: number
  hpmax: number
}

function makeCreature(over: Partial<CreatureInstance> = {}): CreatureInstance {
  return {
    instanceId: 'crt-1',
    templateId: null,
    name: '고블린',
    level: 3,
    hpmax: 30,
    hpcur: 30,
    mpmax: 0,
    mpcur: 0,
    dexterity: 12,
    gold: 0,
    special: 0,
    armor: 0,
    thaco: 10,
    ndice: 1,
    sdice: 6,
    pdice: 0,
    realm: [0, 0, 0, 0],
    spells: '0000000000000000'.repeat(2),
    class: 0,
    intelligence: 0,
    piety: 0,
    flags: '0000000000000000',
    enemies: [],
    inventory: [],
    ...over,
  }
}

const emptyRoom: RoomNode = {
  roomId: 50,
  name: '방',
  shortDesc: '',
  longDesc: '',
  exits: [],
  items: [],
  flags: [0, 0, 0, 0, 0, 0, 0, 0],
  occupants: new Set<string>(),
  creatures: [],
  permMon: [],
  random: [],
  traffic: 0,
}

describe('체크인된 addrealm.json 골든 fixture', () => {
  const loadFixture = () => {
    const url = new URL('../../../shared/src/oracle/fixtures/addrealm.json', import.meta.url)
    const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
    const result = goldenFixtureSchema.safeParse(parsed)
    expect(result.success).toBe(true)
    if (!result.success) throw new Error('addrealm.json 스키마 실패')
    return result.data as Parameters<typeof approve>[0]
  }

  it('goldenFixtureSchema를 통과하고 manual oracle이다', () => {
    const fixture = loadFixture()
    expect(fixture.oracle.method).toBe('manual')
    expect(fixture.cases.length).toBeGreaterThan(0)
  })

  it('approve가 realmGrowthAmount SUT로 전 케이스를 throw 없이 통과한다', () => {
    // anti-tautology: fixture expected는 addRealmFixture.ts의 magic1.c 독립 전사(oracleRealmGrowth),
    // SUT는 realmGrowth.ts realmGrowthAmount. 두 전사가 diff되면 approve가 throw한다.
    const fixture = loadFixture()
    const sut = (input: unknown): unknown => {
      const inp = input as RealmGrowthCaseInput
      return realmGrowthAmount(inp.m, inp.exp, inp.hpmax)
    }
    expect(() => approve(fixture, sut)).not.toThrow()
  })

  it('combat exp 분배와 동형: growth == 단일 기여자 distributeCreatureDeath award.exp', () => {
    // Criterion 5 — realm 성장 base 공식이 deathDistribution expdiv(creature.c:287)와 동형임을 실행 가능하게
    // 고정한다. 케이스마다 exp=experience·dmg=m·hpmax로 단일 기여자(그룹킬 없음) 사망을 재구성해
    // award.exp가 growth와 정확히 일치함을 대조한다.
    const fixture = loadFixture()
    for (const c of fixture.cases as { input: RealmGrowthCaseInput }[]) {
      const inp = c.input
      const growth = realmGrowthAmount(inp.m, inp.exp, inp.hpmax)
      const dead = makeCreature({ hpmax: inp.hpmax, experience: inp.exp, enemies: ['p'] })
      const ledger = createDamageLedger()
      ledger.set('p', inp.m)
      const dist = distributeCreatureDeath(dead, emptyRoom, ledger, {})
      expect(dist.awards).toHaveLength(1)
      expect(dist.awards[0]?.exp).toBe(growth)
    }
  })
})
