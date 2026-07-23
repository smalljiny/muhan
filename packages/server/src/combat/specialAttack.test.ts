import { describe, it, expect } from 'vitest'
import {
  resolveSpecialAttack,
  type SpecialAttacker,
  type SpecialAttackDefender,
} from './specialAttack.js'
import { seqRng } from './dice.testutil.js'
import {
  F_SET,
  MPOISS,
  MBRETH,
  MBRWP1,
  MBRWP2,
  MENEDR,
  MDISEA,
  MDISIT,
  MBLNDR,
  PRFIRE,
  PRCOLD,
} from '../world/hexFlags.js'

/**
 * specialAttack — 몬스터 특수공격 6종의 오라클 확률 게이트·효과(update.c:387~480) 순수 함수 이식.
 *
 * 모든 굴림은 주입 seqRng(순서 고정)로 결정화한다. seqRng는 시퀀스를 초과 호출하면 throw하므로,
 * 각 케이스의 정확한 굴림 순서·개수가 계약으로 고정된다 — 플래그 단축평가(미세팅 게이트 rng 미굴림)와
 * breath↔energy-drain XOR 상호배제(브레스 발동 시 MENEDR 미굴림)가 seq 소진으로 즉시 검증된다.
 *
 * byte-fidelity pin:
 *   - q = Math.trunc((level+3)/4)가 레벨스케일 주사위 개수(C 정수 나눗셈).
 *   - 게이트 임계 경계값: MBRETH rng=4 발동 / rng=5 미발동, MENEDR rng=9 발동 / 10 미발동.
 *   - status는 boolean 마커만(Story 3 grant 미호출, defender 미변형).
 */

const ZERO = '0000000000000000'
function flagsWith(...bits: readonly number[]): string {
  return bits.reduce((hex, bit) => F_SET(hex, bit), ZERO)
}

/** level 5 → q = trunc((5+3)/4) = 2. 산술을 투명하게 만드는 기준 레벨. */
function attacker(...bits: readonly number[]): SpecialAttacker {
  return { level: 5, flags: flagsWith(...bits) }
}

function defender(experience = 100, ...bits: readonly number[]): SpecialAttackDefender {
  return { experience, flags: flagsWith(...bits) }
}

const EMPTY = {
  breathDamage: null,
  breathType: null,
  expDrain: 0,
  poison: false,
  disease: false,
  blind: false,
  dissolveItemRolled: false,
}

describe('resolveSpecialAttack', () => {
  describe('플래그 미세팅 — 게이트 rng 미굴림', () => {
    it('특수공격 플래그가 전혀 없으면 어떤 rng도 굴리지 않고 빈 결과를 반환한다', () => {
      // seqRng([]): 굴림이 발생하면 즉시 throw → "미세팅 게이트는 rng를 굴리지 않는다"를 pin.
      const result = resolveSpecialAttack(attacker(), defender(), { rng: seqRng([]) })
      expect(result).toEqual(EMPTY)
    })
  })

  describe('MBRETH 브레스 게이트 임계 (rng(1,30)<5)', () => {
    it('rng=4면 발동한다 (경계 하단)', () => {
      // spit: MBRWP1만 세팅. dice(q=2,3,0) = 두 번의 rng(1,3). seq=[gate4, 3, 3] → damage 6.
      const result = resolveSpecialAttack(attacker(MBRETH, MBRWP1), defender(), {
        rng: seqRng([4, 3, 3]),
      })
      expect(result.breathType).toBe('spit')
      expect(result.breathDamage).toBe(6)
    })

    it('rng=5면 미발동하고 이후 게이트(MENEDR 미세팅)도 굴리지 않는다', () => {
      // 게이트 실패 → else 분기 → MENEDR 미세팅이라 rng 미굴림. seq=[5]만 소비.
      const result = resolveSpecialAttack(attacker(MBRETH), defender(), { rng: seqRng([5]) })
      expect(result.breathDamage).toBeNull()
      expect(result.breathType).toBeNull()
      expect(result.expDrain).toBe(0)
    })
  })

  describe('브레스 4타입 레벨스케일 주사위 (q = trunc((level+3)/4) = 2)', () => {
    it('침(spit) — MBRWP1 && !MBRWP2 → dice(q,3,0)', () => {
      const result = resolveSpecialAttack(attacker(MBRETH, MBRWP1), defender(), {
        rng: seqRng([1, 2, 3]), // gate1, roll2, roll3 → 0+2+3 = 5
      })
      expect(result.breathType).toBe('spit')
      expect(result.breathDamage).toBe(5)
      expect(result.poison).toBe(false)
    })

    it('악취(gas) — MBRWP1 && MBRWP2 → dice(q,2,1) + poison 부여', () => {
      const result = resolveSpecialAttack(attacker(MBRETH, MBRWP1, MBRWP2), defender(), {
        rng: seqRng([1, 2, 2]), // gate1, roll2, roll2 → pdice1 + 2 + 2 = 5
      })
      expect(result.breathType).toBe('gas')
      expect(result.breathDamage).toBe(5)
      expect(result.poison).toBe(true)
    })

    it('냉기(cold) — !MBRWP1 && MBRWP2, 저항 없으면 dice(q,4,0)', () => {
      const result = resolveSpecialAttack(attacker(MBRETH, MBRWP2), defender(), {
        rng: seqRng([2, 4, 4]), // gate2, roll4, roll4 → 8
      })
      expect(result.breathType).toBe('cold')
      expect(result.breathDamage).toBe(8)
    })

    it('냉기(cold) — PRCOLD 저항이면 dice(q,2,0)로 반감', () => {
      const result = resolveSpecialAttack(attacker(MBRETH, MBRWP2), defender(100, PRCOLD), {
        rng: seqRng([2, 2, 2]), // gate2, roll2, roll2 → 4
      })
      expect(result.breathType).toBe('cold')
      expect(result.breathDamage).toBe(4)
    })

    it('화염(fire) — !MBRWP1 && !MBRWP2, 저항 없으면 dice(q,4,0)', () => {
      const result = resolveSpecialAttack(attacker(MBRETH), defender(), {
        rng: seqRng([3, 4, 4]), // gate3, roll4, roll4 → 8
      })
      expect(result.breathType).toBe('fire')
      expect(result.breathDamage).toBe(8)
    })

    it('화염(fire) — PRFIRE 저항이면 dice(q,2,0)로 반감', () => {
      const result = resolveSpecialAttack(attacker(MBRETH), defender(100, PRFIRE), {
        rng: seqRng([3, 2, 2]), // gate3, roll2, roll2 → 4
      })
      expect(result.breathType).toBe('fire')
      expect(result.breathDamage).toBe(4)
    })
  })

  describe('MENEDR 에너지드레인 (브레스 미발동 시에만, rng(1,100)<10)', () => {
    it('rng=9면 발동, dice(q,5,q*5) 흡수량 산출', () => {
      // q=2 → dice(2,5,10) = pdice10 + roll5 + roll5 = 20. exp=100 상한 미도달.
      const result = resolveSpecialAttack(attacker(MENEDR), defender(100), {
        rng: seqRng([9, 5, 5]),
      })
      expect(result.expDrain).toBe(20)
    })

    it('rng=10이면 미발동한다 (경계 상단)', () => {
      const result = resolveSpecialAttack(attacker(MENEDR), defender(100), { rng: seqRng([10]) })
      expect(result.expDrain).toBe(0)
    })

    it('흡수량은 방어자 experience를 상한으로 클램프한다', () => {
      // drain 20이지만 exp=15 → min(20,15)=15.
      const result = resolveSpecialAttack(attacker(MENEDR), defender(15), {
        rng: seqRng([9, 5, 5]),
      })
      expect(result.expDrain).toBe(15)
    })

    it('experience=0이면 발동 굴림에도 흡수량 0 (max(0,min)) ', () => {
      const result = resolveSpecialAttack(attacker(MENEDR), defender(0), {
        rng: seqRng([9, 5, 5]),
      })
      expect(result.expDrain).toBe(0)
    })
  })

  describe('breath ↔ energy-drain XOR 상호배제', () => {
    it('브레스 발동 시 MENEDR 굴림을 건너뛴다', () => {
      // MBRETH|MBRWP1|MENEDR. 브레스(spit) 발동 → seq=[gate4, 3, 3]만 소비. MENEDR 굴리면 seq 소진 throw.
      const result = resolveSpecialAttack(attacker(MBRETH, MBRWP1, MENEDR), defender(100), {
        rng: seqRng([4, 3, 3]),
      })
      expect(result.breathType).toBe('spit')
      expect(result.breathDamage).toBe(6)
      expect(result.expDrain).toBe(0)
    })

    it('브레스 미발동 시 else 분기에서 MENEDR을 굴린다', () => {
      // MBRETH|MENEDR. 브레스 게이트 실패(5) → else → MENEDR 게이트(9) → 드레인 dice.
      const result = resolveSpecialAttack(attacker(MBRETH, MENEDR), defender(100), {
        rng: seqRng([5, 9, 5, 5]),
      })
      expect(result.breathDamage).toBeNull()
      expect(result.expDrain).toBe(20)
    })
  })

  describe('독립 post-damage 게이트 임계', () => {
    it('MPOISS rng=15 발동 / 16 미발동 (rng(1,100)<=15)', () => {
      const hit = resolveSpecialAttack(attacker(MPOISS), defender(), { rng: seqRng([15]) })
      expect(hit.poison).toBe(true)
      const miss = resolveSpecialAttack(attacker(MPOISS), defender(), { rng: seqRng([16]) })
      expect(miss.poison).toBe(false)
    })

    it('MDISEA rng=10 발동 / 11 미발동 (rng(1,100)<=10)', () => {
      const hit = resolveSpecialAttack(attacker(MDISEA), defender(), { rng: seqRng([10]) })
      expect(hit.disease).toBe(true)
      const miss = resolveSpecialAttack(attacker(MDISEA), defender(), { rng: seqRng([11]) })
      expect(miss.disease).toBe(false)
    })

    it('MBLNDR rng=10 발동 / 11 미발동 (rng(1,100)<=10)', () => {
      const hit = resolveSpecialAttack(attacker(MBLNDR), defender(), { rng: seqRng([10]) })
      expect(hit.blind).toBe(true)
      const miss = resolveSpecialAttack(attacker(MBLNDR), defender(), { rng: seqRng([11]) })
      expect(miss.blind).toBe(false)
    })

    it('MDISIT rng=15 발동 / 16 미발동 — 마커만 (효과 미적용, Non-goal)', () => {
      const hit = resolveSpecialAttack(attacker(MDISIT), defender(), { rng: seqRng([15]) })
      expect(hit.dissolveItemRolled).toBe(true)
      const miss = resolveSpecialAttack(attacker(MDISIT), defender(), { rng: seqRng([16]) })
      expect(miss.dissolveItemRolled).toBe(false)
    })

    it('post 게이트는 MPOISS→MDISEA→MBLNDR→MDISIT 순서로 굴린다', () => {
      const result = resolveSpecialAttack(attacker(MPOISS, MDISEA, MBLNDR, MDISIT), defender(), {
        rng: seqRng([15, 10, 10, 15]),
      })
      expect(result.poison).toBe(true)
      expect(result.disease).toBe(true)
      expect(result.blind).toBe(true)
      expect(result.dissolveItemRolled).toBe(true)
    })
  })

  describe('immutability — 입력 미변형, 새 결과 객체', () => {
    it('attacker·defender 입력을 변형하지 않는다', () => {
      const att = attacker(MENEDR)
      const def = defender(50)
      const attFlags = att.flags
      resolveSpecialAttack(att, def, { rng: seqRng([9, 5, 5]) })
      expect(att.flags).toBe(attFlags)
      expect(att.level).toBe(5)
      expect(def.experience).toBe(50) // 드레인은 마커만, defender.experience 미변형.
    })
  })
})
