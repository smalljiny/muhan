import { describe, it, expect } from 'vitest'
import {
  selectAggroTarget,
  dexEvades,
  resolveAggro,
  type AggroPlayer,
  type AggroAttacker,
} from './aggro.js'
import { seqRng } from './dice.testutil.js'
import {
  F_SET,
  MAGGRE,
  MGAGGR,
  MEAGGR,
  MDINVI,
  PHIDDN,
  PINVIS,
  PDMINV,
} from '../world/hexFlags.js'

/**
 * aggro — 몬스터 선공 타깃선정(update.c:587~608, player.c:1314 lowest_piety / 1473 low_piety_alg)의
 * 순수 함수 이식. 모든 굴림은 주입 seqRng(순서 고정)로 결정화한다 — 시퀀스 초과 호출 시 throw하므로
 * pick 굴림·민첩 회피 굴림의 정확한 순서·개수가 계약으로 고정된다(자격 미달 → pick 미굴림, dex 열세 →
 * 회피 미굴림).
 *
 * 가중 랜덤 pin: weight=MAX(1,C−piety), pick=rng(1,total), 누적 walk하며 total>=pick인 첫 자격 플레이어.
 * MAGGRE는 C=25(lowest_piety), MGAGGR/MEAGGR(alg 변종)은 C=30(low_piety_alg) — 상수 분리 검증.
 */

const ZERO = '0000000000000000'
function flagsWith(...bits: readonly number[]): string {
  return bits.reduce((hex, bit) => F_SET(hex, bit), ZERO)
}

function attacker(
  overrides: Partial<AggroAttacker> = {},
  ...bits: readonly number[]
): AggroAttacker {
  return { level: 5, dexterity: 100, flags: flagsWith(...bits), ...overrides }
}

function player(overrides: Partial<AggroPlayer> = {}): AggroPlayer {
  return {
    id: 'p',
    level: 10,
    piety: 0,
    alignment: 0,
    dexterity: 1,
    flags: ZERO,
    ...overrides,
  }
}

describe('selectAggroTarget — MAGGRE 가중 랜덤(weight 25)', () => {
  // A piety=20 → weight MAX(1,25-20)=5, B piety=10 → weight MAX(1,25-10)=15. total=20.
  // 누적 walk [A,B]: A=5, B=20. pick<=5 → A, pick 6..20 → B.
  const A = player({ id: 'a', piety: 20 })
  const B = player({ id: 'b', piety: 10 })

  it('pick=5는 누적 5인 첫 플레이어 A를 선택한다', () => {
    const t = selectAggroTarget(attacker({}, MAGGRE), [A, B], seqRng([5]))
    expect(t?.id).toBe('a')
  })

  it('pick=6은 누적 20인 B를 선택한다', () => {
    const t = selectAggroTarget(attacker({}, MAGGRE), [A, B], seqRng([6]))
    expect(t?.id).toBe('b')
  })

  it('weight는 MAX(1,25-piety)로 하한 1을 갖는다(piety>=25)', () => {
    // C piety=30 → weight MAX(1,-5)=1. 단독이면 total=1, pick=1 → C.
    const C = player({ id: 'c', piety: 30 })
    const t = selectAggroTarget(attacker({}, MAGGRE), [C], seqRng([1]))
    expect(t?.id).toBe('c')
  })
})

describe('selectAggroTarget — 자격 필터(PHIDDN/PINVIS/PDMINV)', () => {
  it('PHIDDN 플레이어는 제외된다', () => {
    const hidden = player({ id: 'h', piety: 0, flags: flagsWith(PHIDDN) })
    // 자격자 없음 → pick 미굴림(seqRng 빈 시퀀스로도 throw 없이 null).
    const t = selectAggroTarget(attacker({}, MAGGRE), [hidden], seqRng([]))
    expect(t).toBeNull()
  })

  it('PDMINV 플레이어는 무조건 제외된다', () => {
    const dm = player({ id: 'd', flags: flagsWith(PDMINV) })
    const t = selectAggroTarget(attacker({}, MAGGRE), [dm], seqRng([]))
    expect(t).toBeNull()
  })

  it('PINVIS 플레이어는 공격자 MDINVI 없으면 제외된다', () => {
    const inv = player({ id: 'i', flags: flagsWith(PINVIS) })
    const t = selectAggroTarget(attacker({}, MAGGRE), [inv], seqRng([]))
    expect(t).toBeNull()
  })

  it('PINVIS 플레이어는 공격자 MDINVI면 자격을 얻는다', () => {
    const inv = player({ id: 'i', piety: 0, flags: flagsWith(PINVIS) })
    // weight MAX(1,25)=25, total=25, pick=1 → i.
    const t = selectAggroTarget(attacker({}, MAGGRE, MDINVI), [inv], seqRng([1]))
    expect(t?.id).toBe('i')
  })
})

describe('selectAggroTarget — alg 변종 가중 랜덤(weight 30) + alignment 필터', () => {
  // 양수=선(good), 음수=악(evil).
  const good = player({ id: 'good', level: 10, piety: 0, alignment: 100 })
  const evil = player({ id: 'evil', level: 10, piety: 0, alignment: -100 })

  it('MGAGGR(alg=-1)는 선인(alignment>=100)만 대상으로 한다', () => {
    // good weight MAX(1,30)=30 자격, evil 제외. total=30, pick=1 → good.
    const t = selectAggroTarget(attacker({}, MGAGGR), [good, evil], seqRng([1]))
    expect(t?.id).toBe('good')
  })

  it('MEAGGR(alg=+1)는 악인(alignment<=-100)만 대상으로 한다', () => {
    const t = selectAggroTarget(attacker({}, MEAGGR), [good, evil], seqRng([1]))
    expect(t?.id).toBe('evil')
  })

  it('자격자 2인 누적 walk(MGAGGR): weight 30 기준 pick 경계로 선택 플레이어가 갈린다', () => {
    // G1 piety=25 → weight MAX(1,5)=5, G2 piety=10 → weight MAX(1,20)=20. total=25.
    // 누적 [G1,G2]: G1=5, G2=25. pick<=5 → G1, pick 6..25 → G2.
    const g1 = player({ id: 'g1', level: 10, piety: 25, alignment: 100 })
    const g2 = player({ id: 'g2', level: 10, piety: 10, alignment: 100 })
    expect(selectAggroTarget(attacker({}, MGAGGR), [g1, g2], seqRng([5]))?.id).toBe('g1')
    expect(selectAggroTarget(attacker({}, MGAGGR), [g1, g2], seqRng([6]))?.id).toBe('g2')
  })

  it('alg 변종 weight는 MAX(1,30-piety)로 MAGGRE(25)와 다르다', () => {
    // good piety=10 → alg weight MAX(1,20)=20. 단독 total=20, pick=20 → good.
    const g = player({ id: 'good', level: 10, piety: 10, alignment: 100 })
    const t = selectAggroTarget(attacker({}, MGAGGR), [g], seqRng([20]))
    expect(t?.id).toBe('good')
    // pick=21은 total 초과라 논리상 도달 불가 — weight 30 통합이면 total=20+가 되어 이 pin이 깨진다.
  })
})

describe('selectAggroTarget — alg 변종 레벨 게이트(통일된 eligible set)', () => {
  // attacker level=5 → lvl=trunc((5+3)/4)=2. 자격: trunc((player.level+3)/4)>=2 → player.level>=5.
  it('레벨 tier 미달 플레이어는 제외된다(player.level=4)', () => {
    const low = player({ id: 'low', level: 4, alignment: 100 })
    const t = selectAggroTarget(attacker({}, MGAGGR), [low], seqRng([]))
    expect(t).toBeNull()
  })

  it('레벨 tier 충족 플레이어는 자격을 얻는다(player.level=5)', () => {
    const ok = player({ id: 'ok', level: 5, piety: 0, alignment: 100 })
    const t = selectAggroTarget(attacker({}, MGAGGR), [ok], seqRng([1]))
    expect(t?.id).toBe('ok')
  })
})

describe('dexEvades — 민첩 회피(dex 우위 && rng<4, 30%)', () => {
  it('target.dex>attacker.dex && rng=3(<4)이면 회피한다', () => {
    const a = attacker({ dexterity: 10 })
    const t = player({ dexterity: 20 })
    expect(dexEvades(a, t, seqRng([3]))).toBe(true)
  })

  it('rng=4는 회피 임계 미달(<4 아님)이라 회피하지 않는다', () => {
    const a = attacker({ dexterity: 10 })
    const t = player({ dexterity: 20 })
    expect(dexEvades(a, t, seqRng([4]))).toBe(false)
  })

  it('target.dex<=attacker.dex면 회피 굴림을 소비하지 않는다', () => {
    const a = attacker({ dexterity: 20 })
    const t = player({ dexterity: 20 })
    // seqRng([]) — 굴림 시도하면 throw. dex 열세 short-circuit 검증.
    expect(dexEvades(a, t, seqRng([]))).toBe(false)
  })
})

describe('resolveAggro — 타깃선정 + 회피 통합(pick → 회피 순서)', () => {
  it('공격 플래그 없으면 굴림 없이 target null', () => {
    const r = resolveAggro(attacker({}), [player({ piety: 0 })], seqRng([]))
    expect(r).toEqual({ target: null, evaded: false })
  })

  it('타깃 있고 dex 열세(회피 없음)면 target 반환, evaded=false', () => {
    // attacker dex 100 > target dex 1 → 회피 굴림 없음. pick만 소비.
    const p = player({ id: 'x', piety: 0, dexterity: 1 })
    const r = resolveAggro(attacker({ dexterity: 100 }, MAGGRE), [p], seqRng([1]))
    expect(r.target?.id).toBe('x')
    expect(r.evaded).toBe(false)
  })

  it('타깃 있고 dex 우위 + rng=3이면 회피(target null, evaded=true)', () => {
    const p = player({ id: 'x', piety: 0, dexterity: 100 })
    // pick=1, 그다음 회피 굴림 3(<4) → 회피.
    const r = resolveAggro(attacker({ dexterity: 10 }, MAGGRE), [p], seqRng([1, 3]))
    expect(r.target).toBeNull()
    expect(r.evaded).toBe(true)
  })

  it('타깃 있고 dex 우위지만 회피 실패(rng=4)면 target 반환', () => {
    const p = player({ id: 'x', piety: 0, dexterity: 100 })
    const r = resolveAggro(attacker({ dexterity: 10 }, MAGGRE), [p], seqRng([1, 4]))
    expect(r.target?.id).toBe('x')
    expect(r.evaded).toBe(false)
  })

  it('자격 타깃 없으면 pick 미굴림, target null', () => {
    const hidden = player({ flags: flagsWith(PHIDDN) })
    const r = resolveAggro(attacker({}, MAGGRE), [hidden], seqRng([]))
    expect(r).toEqual({ target: null, evaded: false })
  })
})

describe('selectAggroTarget — 입력 불변', () => {
  it('players 배열·요소를 변형하지 않는다', () => {
    const A = player({ id: 'a', piety: 20 })
    const snapshot = structuredClone(A)
    selectAggroTarget(attacker({}, MAGGRE), [A], seqRng([1]))
    expect(A).toEqual(snapshot)
  })
})
