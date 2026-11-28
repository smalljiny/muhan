import { describe, it, expect, vi } from 'vitest'

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
  monster,
  player,
  only,
  expectedMonsterDamage,
  useTrackedHarness,
} from './creatureTickLiveWorld.testutil.js'

/**
 * 몬스터 단위 예외 격리 통합 테스트 — 크리처 tick은 `onCombatTick`을 try/catch 없이 부르므로, 프로덕션
 * 래퍼가 격리하지 않으면 한 몬스터의 예외가 같은 tick의 나머지 몬스터 전투를 통째로 건너뛰게 한다.
 *
 * 손상 데이터 재현: 몬스터 A의 `enemies`는 길이(1)는 정상이지만 순회하면 throw하는 배열이다. 크리처 tick의
 * 조기종료 게이트(`enemies.length`)는 통과하고, 전투 tick 안의 present 적 해석(순회)에서 터진다 — 굴림을
 * 하나도 소비하기 전이라 B의 굴림 예산에 섞이지 않는다.
 */

const P = 'char-p'

const harness = useTrackedHarness()

/** 길이는 정상이지만 순회하면 throw하는 enemies — 전투 tick 내부에서만 터지는 손상 데이터. */
function corruptedEnemies(): string[] {
  const enemies = [P]
  Object.defineProperty(enemies, Symbol.iterator, {
    value: () => {
      throw new Error('손상된 enemies')
    },
  })
  return enemies
}

describe('몬스터 단위 예외 격리 — 프로덕션 조립 경로', () => {
  it('몬스터 A의 전투 tick이 throw해도 같은 tick의 몬스터 B는 정상 행동하고, A만 로그에 남는다', async () => {
    const a = monster(`${ARENA}:c0`, '망가진고블린', { enemies: corruptedEnemies() })
    const b = monster(`${ARENA}:c1`, '오크', { enemies: [P] })
    const h = harness({ arenaCreatures: [a, b], seeds: [player(P, '용사', ARENA)] })
    await h.enter(P)
    h.clearSent()
    const hpBefore = h.state(P).hpCurrent
    const bDamage = expectedMonsterDamage(b, h.state(P))

    // 굴림 예산 2: B 근접 명중 1 + P 반격 빗맞음 1. A는 굴림 전에 터진다.
    combatRngScript.load([MONSTER_HIT, MISS])
    expect(() => h.runCreatureTick()).not.toThrow()
    expect(combatRngScript.remaining()).toBe(0)

    // B는 같은 tick에 행동했다 — 피해와 라운드 통지.
    expect(h.state(P).hpCurrent).toBe(hpBefore - bDamage)
    const round = only(h.eventsFor(P), 'combat:round')
    expect(round.creatureInstanceId).toBe(b.instanceId)

    // A의 실패는 A의 instanceId·방 번호와 함께 1회 기록된다.
    expect(h.logger.error).toHaveBeenCalledTimes(1)
    expect(h.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: new Error('손상된 enemies'),
        creatureInstanceId: a.instanceId,
        roomId: ARENA,
      }),
      expect.any(String),
    )
  })
})
