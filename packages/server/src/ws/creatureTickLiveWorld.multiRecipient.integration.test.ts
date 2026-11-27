import { describe, it, expect, vi } from 'vitest'
import type { CreatureInstance } from 'shared'

// 굴림 결정성 — `creatureTickLiveWorld.integration.test.ts`와 같은 문서화된 예외(defaultCombatRng export만 교체).
vi.mock('../combat/dice.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../combat/dice.js')>()
  const { combatRngScript } = await import('./scriptedCombatRng.testutil.js')
  return { ...actual, defaultCombatRng: combatRngScript.rng }
})

import { combatRngScript } from './scriptedCombatRng.testutil.js'
import {
  ARENA,
  MONSTER_HIT,
  MISS,
  CAST_PASS,
  SPELL_PICK,
  SVIGOR_ROLL,
  COUNTER_HIT,
  SVIGOR,
  monster,
  player,
  spellsWith,
  only,
  expectedCounterDamage,
  expectedMonsterDamage,
  useTrackedHarness,
  type LiveWorldHarness,
} from './creatureTickLiveWorld.testutil.js'
import { MMAGIC } from '../world/hexFlags.js'
import { flagsHex } from '../world/roomFixtures.testutil.js'

/**
 * 다인 라운드 와이어 값 통합 테스트(스펙 G4) — 표적 T와 반격만 한 플레이어 C가 있는 라운드에서 두 사람이
 * 받는 `combat:round`가 수신자별 투영으로 갈린다. 구분해야 하는 세 경우를 각각 별도 `it`으로 둔다:
 * 표적 근접 빗맞음 / 반격 전용(received null) / 자기 회복 시전을 받은 표적(cast, damage 0).
 *
 * 몬스터 enemies는 [T, C] — presentEnemies[0]인 T가 표적, C는 반격 순서상 먼저(다른 적 → 표적 마지막) 굴린다.
 */

const T = 'char-t'
const C = 'char-c'

const harness = useTrackedHarness()

async function enterPair(m: CreatureInstance): Promise<LiveWorldHarness> {
  const h = harness({
    arenaCreatures: [m],
    seeds: [player(T, '표적이', ARENA), player(C, '반격이', ARENA)],
  })
  await h.enter(T)
  await h.enter(C)
  h.clearSent()
  return h
}

describe('다인 라운드 와이어 값 — 프로덕션 조립 경로', () => {
  it('표적의 근접 빗맞음: 표적은 received melee·hit false, 반격 전용 플레이어와 다른 값을 받는다', async () => {
    const m = monster(`${ARENA}:c0`, '고블린', { enemies: [T, C] })
    const h = await enterPair(m)
    const cCounterDamage = expectedCounterDamage(h.state(C))

    // 굴림 예산 5: 근접 T 빗맞음 1 + C 반격 명중 3 + T 반격 빗맞음 1.
    combatRngScript.load([MISS, ...COUNTER_HIT, MISS])
    h.runCreatureTick()
    expect(combatRngScript.remaining()).toBe(0)

    const tRound = only(h.eventsFor(T), 'combat:round')
    const cRound = only(h.eventsFor(C), 'combat:round')
    expect(tRound.received).toEqual({
      kind: 'melee',
      hit: false,
      damage: 0,
      critical: false,
      fumble: false,
    })
    expect(tRound.counter).toEqual({ hit: false, damage: 0, critical: false, fumble: false })
    expect(cRound.received).toBeNull()
    expect(cRound.counter).toEqual({
      hit: true,
      damage: cCounterDamage,
      critical: false,
      fumble: false,
    })
    expect(tRound).not.toEqual(cRound)
  })

  it('반격만 한 플레이어: received null·counter 값만 받고, 피해·경험치가 없어 stats를 받지 않는다', async () => {
    const m = monster(`${ARENA}:c0`, '고블린', { enemies: [T, C] })
    const h = await enterPair(m)
    const tDamage = expectedMonsterDamage(m, h.state(T))
    const cCounterDamage = expectedCounterDamage(h.state(C))

    // 굴림 예산 5: 근접 T 명중 1 + C 반격 명중 3 + T 반격 빗맞음 1.
    combatRngScript.load([MONSTER_HIT, ...COUNTER_HIT, MISS])
    h.runCreatureTick()
    expect(combatRngScript.remaining()).toBe(0)

    expect(h.eventsFor(C)).toEqual([
      {
        type: 'combat:round',
        creatureInstanceId: m.instanceId,
        creatureName: '고블린',
        received: null,
        counter: { hit: true, damage: cCounterDamage, critical: false, fumble: false },
        monsterDied: false,
        youDied: false,
      },
    ])
    // 표적은 같은 라운드에서 근접 명중 값을 받는다(피해 → stats도 받는다).
    expect(only(h.eventsFor(T), 'combat:round').received).toEqual({
      kind: 'melee',
      hit: true,
      damage: tDamage,
      critical: false,
      fumble: false,
    })
    expect(h.eventsFor(T).map((e) => e.type)).toEqual(['combat:round', 'character:stats'])
  })

  it('자기 회복 시전을 받은 표적: received cast·damage 0, 반격 전용 플레이어는 received null', async () => {
    const m = monster(`${ARENA}:c0`, '요술쟁이', {
      flags: flagsHex(MMAGIC),
      spells: spellsWith(SVIGOR),
      hpcur: 500,
      enemies: [T, C],
    })
    const h = await enterPair(m)
    const tHpBefore = h.state(T).hpCurrent

    // 굴림 예산 5: 시전 확률 1 + 주문 선택 1 + 활력 회복 1d6 1 + C 반격 빗맞음 1 + T 반격 빗맞음 1.
    // 자기 회복은 표적을 건드리지 않아 근접을 대체하고('cast'), 반격은 그대로 진행한다.
    combatRngScript.load([CAST_PASS, SPELL_PICK, SVIGOR_ROLL, MISS, MISS])
    h.runCreatureTick()
    expect(combatRngScript.remaining()).toBe(0)

    expect(only(h.eventsFor(T), 'combat:round').received).toEqual({ kind: 'cast', damage: 0 })
    expect(only(h.eventsFor(C), 'combat:round').received).toBeNull()
    expect(h.state(T).hpCurrent).toBe(tHpBefore)
    // 시전은 실제로 몬스터 자신을 회복시켰다.
    expect(h.creatureIn(h.arena, m.instanceId)?.hpcur).toBeGreaterThan(500)
    // 피해 없는 표적은 stats를 받지 않는다.
    expect(h.eventsFor(T).map((e) => e.type)).toEqual(['combat:round'])
  })
})
