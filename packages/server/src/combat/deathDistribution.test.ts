import { describe, it, expect } from 'vitest'
import type { CreatureInstance, ItemInstance, RoomNode } from 'shared'
import { distributeCreatureDeath } from './deathDistribution.js'
import { createDamageLedger, type DamageLedger } from './enmity.js'
import { MTRADE } from '../world/hexFlags.js'

/**
 * deathDistribution.ts — 몬스터 사망 exp 분배·전리품 드롭 resolver(creature.c:274~341 이식) 테스트.
 *
 * 오라클 실 분배 루프(B 블록)를 정본으로: 데미지비례 exp·MIN(expgroup, 몬스터exp) 캡·멤버십 게이트
 * (enemies AND ledger>0)·그룹킬 보너스(기여자 2명+ 결정론, 미초기화 cp 버그 비재현)·MTRADE 인벤토리
 * 게이트·무게이트 골드 드롭을 검증한다. resolver는 무변형·반환 기반이라 dead·room·ledger 불변도 pin한다.
 *
 * plan divergence: alignment 페널티는 **기여자마다**(오라클 루프 내부) — 플랜 T7.2 "살해자" 대신
 * 오라클 충실 이식. 아래 groupkill·multi-contributor 케이스가 이를 pin한다.
 */

/** 지정 M-flag 비트를 세팅한 hex string flags(8바이트=16 hex chars). */
function flagsWith(...bits: number[]): string {
  const bytes = new Array<number>(8).fill(0)
  for (const bit of bits) {
    const idx = Math.floor(bit / 8)
    bytes[idx] = (bytes[idx] ?? 0) | (1 << bit % 8)
  }
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** 빈 flags(M-flag 미세팅). */
const NO_FLAGS = flagsWith()

/** 최소 ItemInstance 픽스처. */
function makeItem(overrides: Partial<ItemInstance> = {}): ItemInstance {
  return {
    instanceId: 'item-1',
    name: '단검',
    description: '',
    value: 5,
    flags: '',
    contains: [],
    ...overrides,
  }
}

/** 죽은 몬스터 픽스처. experience/alignment/gold/inventory/enemies·flags는 override. */
function makeDead(overrides: Partial<CreatureInstance> = {}): CreatureInstance {
  return {
    instanceId: 'mon-1',
    templateId: 5,
    name: '고블린',
    level: 3,
    hpmax: 100,
    hpcur: 0,
    mpmax: 0,
    mpcur: 0,
    dexterity: 10,
    gold: 0,
    special: 0,
    armor: 0,
    thaco: 20,
    ndice: 1,
    sdice: 6,
    pdice: 0,
    realm: [0, 0, 0, 0],
    spells: '',
    class: 0,
    intelligence: 10,
    piety: 10,
    experience: 1000,
    alignment: 0,
    flags: NO_FLAGS,
    enemies: [],
    inventory: [],
    ...overrides,
  }
}

/** 최소 RoomNode(resolver는 room을 변형하지 않고 읽지도 않음 — 시그니처 컨텍스트용). */
function makeRoom(): RoomNode {
  return {
    roomId: 1,
    name: '',
    shortDesc: '',
    longDesc: '',
    exits: [],
    items: [],
    flags: new Array<number>(8).fill(0),
    occupants: new Set<string>(),
    creatures: [],
    permMon: [],
    random: [],
    traffic: 0,
  }
}

/** enemies·ledger를 함께 세팅한다(멤버십 게이트 테스트용). */
function ledgerOf(entries: Array<[string, number]>): DamageLedger {
  const ledger = createDamageLedger()
  for (const [id, dmg] of entries) ledger.set(id, dmg)
  return ledger
}

describe('distributeCreatureDeath', () => {
  describe('exp 분배(데미지 비례·캡)', () => {
    it('단독 기여자에게 데미지 비례 exp를 분배한다(expdiv = exp*dmg/hpmax)', () => {
      const dead = makeDead({ experience: 1000, hpmax: 100, alignment: 0, enemies: ['p1'] })
      const ledger = ledgerOf([['p1', 40]])
      const result = distributeCreatureDeath(dead, makeRoom(), ledger, {})
      // expdiv = trunc(1000*40/100)=400, 단독이라 그룹킬 아님 → expgroup=400.
      expect(result.awards).toEqual([{ playerId: 'p1', exp: 400, alignmentDelta: 0 }])
    })

    it('expgroup을 몬스터 exp로 캡한다(MIN(expgroup, exp))', () => {
      const dead = makeDead({ experience: 1000, hpmax: 100, alignment: 0, enemies: ['p1'] })
      // dmg 200 > hpmax → expdiv = trunc(1000*200/100)=2000 > 1000 → 캡 1000.
      const ledger = ledgerOf([['p1', 200]])
      const result = distributeCreatureDeath(dead, makeRoom(), ledger, {})
      expect(result.awards).toEqual([{ playerId: 'p1', exp: 1000, alignmentDelta: 0 }])
    })

    it('정수 절삭(Math.trunc)으로 exp를 계산한다', () => {
      const dead = makeDead({ experience: 1000, hpmax: 300, alignment: 0, enemies: ['p1'] })
      // trunc(1000*100/300) = trunc(333.33) = 333.
      const ledger = ledgerOf([['p1', 100]])
      const result = distributeCreatureDeath(dead, makeRoom(), ledger, {})
      expect(result.awards).toEqual([{ playerId: 'p1', exp: 333, alignmentDelta: 0 }])
    })

    it('experience 선택 필드 미설정 시 0으로 폴백한다', () => {
      const dead = makeDead({ experience: undefined, alignment: undefined, enemies: ['p1'] })
      const ledger = ledgerOf([['p1', 50]])
      const result = distributeCreatureDeath(dead, makeRoom(), ledger, {})
      // exp 0 → expdiv 0, alignment 0 → delta 0. 기여자는 여전히 award를 받는다.
      expect(result.awards).toEqual([{ playerId: 'p1', exp: 0, alignmentDelta: 0 }])
    })
  })

  describe('멤버십 게이트(enemies AND ledger>0)', () => {
    it('enemies 멤버가 아니면 데미지가 있어도 제외한다', () => {
      const dead = makeDead({ experience: 1000, hpmax: 100, enemies: ['p1'] })
      // p2는 데미지가 있으나 enemies 리스트에 없음 → 제외. p1만 수령.
      const ledger = ledgerOf([
        ['p1', 40],
        ['p2', 60],
      ])
      const result = distributeCreatureDeath(dead, makeRoom(), ledger, {})
      expect(result.awards).toEqual([{ playerId: 'p1', exp: 400, alignmentDelta: 0 }])
    })

    it('enemies 멤버여도 데미지 0이면 제외한다', () => {
      const dead = makeDead({ experience: 1000, hpmax: 100, enemies: ['p1', 'p2'] })
      // p2는 enemies 멤버지만 ledger 데미지 0(미기록) → 제외.
      const ledger = ledgerOf([['p1', 40]])
      const result = distributeCreatureDeath(dead, makeRoom(), ledger, {})
      expect(result.awards).toEqual([{ playerId: 'p1', exp: 400, alignmentDelta: 0 }])
    })

    it('awards 순서는 enemies 배열 순서를 따른다(ledger Map 순서 아님)', () => {
      const dead = makeDead({ experience: 1000, hpmax: 100, enemies: ['pA', 'pB'] })
      // ledger 삽입 순서를 enemies와 반대로 세팅 — enemies 순서(pA, pB)로 나와야 한다.
      const ledger = ledgerOf([
        ['pB', 10],
        ['pA', 10],
      ])
      const result = distributeCreatureDeath(dead, makeRoom(), ledger, {})
      expect(result.awards.map((a) => a.playerId)).toEqual(['pA', 'pB'])
    })
  })

  describe('그룹킬 보너스(기여자 2명+ 결정론)', () => {
    it('기여자 2명+ 시 각 기여자에 +exp/10 보너스를 적용한다', () => {
      const dead = makeDead({ experience: 1000, hpmax: 100, alignment: 0, enemies: ['p1', 'p2'] })
      const ledger = ledgerOf([
        ['p1', 40],
        ['p2', 30],
      ])
      const result = distributeCreatureDeath(dead, makeRoom(), ledger, {})
      // 그룹킬: p1 expdiv=400 +100=500, p2 expdiv=300 +100=400.
      expect(result.awards).toEqual([
        { playerId: 'p1', exp: 500, alignmentDelta: 0 },
        { playerId: 'p2', exp: 400, alignmentDelta: 0 },
      ])
    })

    it('단독 기여자는 그룹킬 보너스가 없다(미초기화 cp 버그 비재현)', () => {
      const dead = makeDead({ experience: 1000, hpmax: 100, alignment: 0, enemies: ['p1'] })
      const ledger = ledgerOf([['p1', 40]])
      const result = distributeCreatureDeath(dead, makeRoom(), ledger, {})
      // 단독 → 보너스 없음. expgroup=400(500 아님).
      expect(result.awards).toEqual([{ playerId: 'p1', exp: 400, alignmentDelta: 0 }])
    })

    it('그룹킬 보너스 후에도 exp 캡을 적용한다', () => {
      const dead = makeDead({ experience: 1000, hpmax: 100, alignment: 0, enemies: ['p1', 'p2'] })
      // p1 expdiv = trunc(1000*95/100)=950, +100=1050 → 캡 1000.
      const ledger = ledgerOf([
        ['p1', 95],
        ['p2', 30],
      ])
      const result = distributeCreatureDeath(dead, makeRoom(), ledger, {})
      expect(result.awards[0]).toEqual({ playerId: 'p1', exp: 1000, alignmentDelta: 0 })
    })
  })

  describe('alignment 페널티(기여자마다 — plan divergence)', () => {
    it('각 기여자에 -trunc(alignment/5) delta를 담는다', () => {
      const dead = makeDead({ experience: 1000, hpmax: 100, alignment: 500, enemies: ['p1', 'p2'] })
      const ledger = ledgerOf([
        ['p1', 40],
        ['p2', 30],
      ])
      const result = distributeCreatureDeath(dead, makeRoom(), ledger, {})
      // alignmentDelta = -trunc(500/5) = -100, 두 기여자 모두.
      expect(result.awards.map((a) => a.alignmentDelta)).toEqual([-100, -100])
    })

    it('음수 alignment는 Math.trunc(0 방향 절삭)로 계산한다(Math.floor 아님)', () => {
      const dead = makeDead({ experience: 1000, hpmax: 100, alignment: -13, enemies: ['p1'] })
      const ledger = ledgerOf([['p1', 40]])
      const result = distributeCreatureDeath(dead, makeRoom(), ledger, {})
      // -trunc(-13/5) = -trunc(-2.6) = -(-2) = 2. (floor면 -(-3)=3으로 발산.) exp = trunc(1000*40/100)=400.
      expect(result.awards).toEqual([{ playerId: 'p1', exp: 400, alignmentDelta: 2 }])
    })

    it('exp 0 기여자도 alignmentDelta를 받는다(early-skip 금지)', () => {
      const dead = makeDead({ experience: undefined, alignment: 500, enemies: ['p1'] })
      const ledger = ledgerOf([['p1', 40]])
      const result = distributeCreatureDeath(dead, makeRoom(), ledger, {})
      expect(result.awards).toEqual([{ playerId: 'p1', exp: 0, alignmentDelta: -100 }])
    })
  })

  describe('골드 드롭(무게이트)', () => {
    it('gold>0이면 ItemInstance(value=금액)로 drops에 반환한다', () => {
      const dead = makeDead({ gold: 250, enemies: ['p1'] })
      const ledger = ledgerOf([['p1', 40]])
      const result = distributeCreatureDeath(dead, makeRoom(), ledger, {})
      expect(result.drops).toEqual([
        {
          instanceId: 'mon-1:gold',
          name: '250냥',
          description: '',
          value: 250,
          flags: '',
          contains: [],
        },
      ])
    })

    it('gold 0이면 골드 드롭이 없다', () => {
      const dead = makeDead({ gold: 0, enemies: ['p1'] })
      const ledger = ledgerOf([['p1', 40]])
      const result = distributeCreatureDeath(dead, makeRoom(), ledger, {})
      expect(result.drops).toEqual([])
    })

    it('MTRADE여도 골드는 드롭한다(골드는 무게이트)', () => {
      const dead = makeDead({ gold: 100, flags: flagsWith(MTRADE), enemies: ['p1'] })
      const ledger = ledgerOf([['p1', 40]])
      const result = distributeCreatureDeath(dead, makeRoom(), ledger, {})
      expect(result.drops).toEqual([
        {
          instanceId: 'mon-1:gold',
          name: '100냥',
          description: '',
          value: 100,
          flags: '',
          contains: [],
        },
      ])
    })
  })

  describe('인벤토리 드롭(MTRADE 게이트)', () => {
    it('인벤토리 아이템을 instanceId 유지한 채 drops에 담는다', () => {
      const sword = makeItem({ instanceId: 'sword-9', name: '장검' })
      const dead = makeDead({ inventory: [sword], enemies: ['p1'] })
      const ledger = ledgerOf([['p1', 40]])
      const result = distributeCreatureDeath(dead, makeRoom(), ledger, {})
      expect(result.drops).toEqual([sword])
    })

    it('MTRADE면 인벤토리를 드롭하지 않는다', () => {
      const sword = makeItem({ instanceId: 'sword-9' })
      const dead = makeDead({ inventory: [sword], flags: flagsWith(MTRADE), enemies: ['p1'] })
      const ledger = ledgerOf([['p1', 40]])
      const result = distributeCreatureDeath(dead, makeRoom(), ledger, {})
      expect(result.drops).toEqual([])
    })

    it('인벤토리+골드를 함께 드롭한다(인벤토리 먼저, 골드 뒤 — 오라클 순서)', () => {
      const sword = makeItem({ instanceId: 'sword-9', name: '장검' })
      const dead = makeDead({ inventory: [sword], gold: 50, enemies: ['p1'] })
      const ledger = ledgerOf([['p1', 40]])
      const result = distributeCreatureDeath(dead, makeRoom(), ledger, {})
      expect(result.drops).toEqual([
        sword,
        {
          instanceId: 'mon-1:gold',
          name: '50냥',
          description: '',
          value: 50,
          flags: '',
          contains: [],
        },
      ])
    })
  })

  describe('drops는 기여자와 독립', () => {
    it('기여자가 없어도 골드·인벤토리는 드롭한다(awards 빈 배열)', () => {
      const sword = makeItem({ instanceId: 'sword-9' })
      const dead = makeDead({ gold: 30, inventory: [sword], enemies: [] })
      const ledger = createDamageLedger()
      const result = distributeCreatureDeath(dead, makeRoom(), ledger, {})
      expect(result.awards).toEqual([])
      expect(result.drops).toEqual([
        sword,
        {
          instanceId: 'mon-1:gold',
          name: '30냥',
          description: '',
          value: 30,
          flags: '',
          contains: [],
        },
      ])
    })
  })

  describe('immutability(무변형)', () => {
    it('dead·room·ledger·inventory를 변형하지 않는다', () => {
      const sword = makeItem({ instanceId: 'sword-9' })
      const dead = makeDead({
        experience: 1000,
        hpmax: 100,
        alignment: 500,
        gold: 100,
        inventory: [sword],
        enemies: ['p1', 'p2'],
      })
      const room = makeRoom()
      const ledger = ledgerOf([
        ['p1', 40],
        ['p2', 30],
      ])
      const deadSnapshot = structuredClone(dead)
      const roomItemsBefore = room.items
      const ledgerSnapshot = new Map(ledger)

      distributeCreatureDeath(dead, room, ledger, {})

      expect(dead).toEqual(deadSnapshot)
      expect(dead.inventory).toContain(sword) // 인벤토리 참조 보존.
      expect(room.items).toBe(roomItemsBefore) // room.items in-place push 아님.
      expect(room.items).toEqual([])
      expect(ledger).toEqual(ledgerSnapshot)
    })
  })
})
