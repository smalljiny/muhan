import { describe, it, expect, vi } from 'vitest'
import { resolveHpMax, type Character, type CreatureInstance } from 'shared'

// 굴림 결정성 — `creatureTickLiveWorld.integration.test.ts`와 같은 문서화된 예외(defaultCombatRng export만 교체).
vi.mock('../combat/dice.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../combat/dice.js')>()
  const { combatRngScript } = await import('./scriptedCombatRng.testutil.js')
  return { ...actual, defaultCombatRng: combatRngScript.rng }
})

import { combatRngScript } from './scriptedCombatRng.testutil.js'
import {
  ARENA,
  REVIVE,
  START_TICK,
  MONSTER_HIT,
  MISS,
  CAST_PASS,
  SPELL_PICK,
  SHURTS_ROLL,
  RICH_EXP,
  COUNTER_HIT,
  SHURTS,
  monster,
  player,
  spellsWith,
  only,
  expectedCounterDamage,
  useTrackedHarness,
  type RoundEvent,
  type LiveWorldHarness,
} from './creatureTickLiveWorld.testutil.js'
import { applyPlayerDeath } from '../progression/death.js'
import { MMAGIC } from '../world/hexFlags.js'
import { flagsHex } from '../world/roomFixtures.testutil.js'

/**
 * 사망 취소 상태(D8) 통합 테스트 — 프로덕션 조립 경로(바인딩 슬롯 + worldRuntime + wiring)로 스펙 G4의
 * (a) 근접 명중 → 라운드 끝 사망 1회, (b) MMAGIC 'cast' → 사망 없음, (c) 근접 명중 + 다른 플레이어 반격 처치
 * → 재취소, 그리고 D8 빗맞음 와이어 값을 검증한다. 하네스·굴림 큐는 메인 통합 테스트와 같다.
 *
 * 공통 전제(`enterDeathCancelled`): HP 1 플레이어 P를 앞 몬스터가 근접으로 HP<1로 떨어뜨리고, P의 마지막
 * 반격이 그 몬스터를 죽여 사망이 취소된다(update.c `goto crt_died; if(rtn) continue`). P는 HP<1인 채 전투
 * 방에 남는다. 검증 대상 몬스터 B는 다음 tick(START_TICK+1)에야 행동이 도래하도록 둔다.
 */

const P = 'char-p'
const Q = 'char-q'

/** B의 행동 도래 시각 — 전제 tick(START_TICK)에는 행동하지 않는다. */
const NEXT_TICK = START_TICK + 1

const harness = useTrackedHarness()

/** 사망 취소 상태의 P를 만든 하네스를 돌려준다. 시계는 B가 도래하는 NEXT_TICK, 송신 기록은 비워 둔다. */
async function enterDeathCancelled(
  follower: CreatureInstance,
  extraSeeds: readonly Character[] = [],
): Promise<LiveWorldHarness> {
  const opener = monster(`${ARENA}:c0`, '고블린', { hpmax: 10, hpcur: 1, enemies: [P] })
  const h = harness({
    arenaCreatures: [opener, follower],
    seeds: [player(P, '갑돌', ARENA, { hpCurrent: 1, experience: RICH_EXP }), ...extraSeeds],
  })
  await h.enter(P)
  for (const seed of extraSeeds) await h.enter(seed._id)

  // 전제 굴림 예산 4: 고블린 근접 명중 1(P HP<1 → 사망 대기) + P 반격 명중 3(고블린 처치 → 사망 취소).
  combatRngScript.load([MONSTER_HIT, ...COUNTER_HIT])
  h.runCreatureTick()
  expect(combatRngScript.remaining()).toBe(0)

  const round = only(h.eventsFor(P), 'combat:round')
  expect(round.monsterDied).toBe(true)
  expect(round.youDied).toBe(false)
  expect(h.state(P).hpCurrent).toBeLessThan(1)
  expect(h.live(P).currentRoom).toBe(ARENA)
  expect(h.arena.occupants.has(P)).toBe(true)
  expect(h.creatureIn(h.arena, opener.instanceId)).toBeUndefined()
  // 되쓰기가 같은 라운드 적립 경험치를 덮지 않는다 — P는 피해(상태 변경자)와 처치 보상(경험치 수령자)을 함께
  // 받았고, 저장 스냅샷은 적립된 경험치와 D8 HP 0(applyVitals 하한 클램프)을 함께 싣는다.
  expect(h.lastSaved(P)?.experience).toBeGreaterThan(RICH_EXP)
  expect(h.lastSaved(P)?.experience).toBe(h.live(P).experience)
  expect(h.lastSaved(P)?.hpCurrent).toBe(0)

  h.setNow(NEXT_TICK)
  h.clearSent()
  return h
}

describe('사망 취소 상태 표적(D8) — 프로덕션 조립 경로', () => {
  it('(a) 다른 몬스터의 근접이 명중하면 라운드 끝에 사망 1회(피해 0) → 1008 부활', async () => {
    const follower = monster(`${ARENA}:c1`, '오크', { enemies: [P], nextActionAt: NEXT_TICK })
    const h = await enterDeathCancelled(follower)
    const liveBefore = h.live(P)

    // 굴림 예산 1: 오크 근접 명중 판정(rollHit)만. 피해 굴림 없음, P는 반격하지 않는다(aliveAtStart).
    combatRngScript.load([MONSTER_HIT])
    h.runCreatureTick()
    expect(combatRngScript.remaining()).toBe(0)

    const events = h.eventsFor(P)
    expect(events.map((e) => e.type)).toEqual(['combat:round', 'character:stats', 'world:room'])
    expect(only(events, 'combat:round')).toEqual<RoundEvent>({
      type: 'combat:round',
      creatureInstanceId: follower.instanceId,
      creatureName: '오크',
      received: { kind: 'melee', hit: true, damage: 0, critical: false, fumble: false },
      counter: null,
      monsterDied: false,
      youDied: true,
    })
    // 사망 1회 — 경험치 손실이 한 번만 적용됐고, 부활 방에 풀회복으로 배치됐다.
    expect(h.live(P).experience).toBe(applyPlayerDeath(liveBefore).experience)
    expect(h.live(P).currentRoom).toBe(REVIVE)
    expect(h.revive.occupants.has(P)).toBe(true)
    expect(h.state(P).hpCurrent).toBe(resolveHpMax(liveBefore))
    // 피해 차감·원장 누적 없음.
    expect(h.creatureIn(h.arena, follower.instanceId)?.hpcur).toBe(1000)
    expect(h.wiring.attackDeps.ledgers.for(follower.instanceId).has(P)).toBe(false)
  })

  it('(b) MMAGIC 시전 확률을 통과해 cast가 나오면 그 라운드에는 사망하지 않는다', async () => {
    const follower = monster(`${ARENA}:c1`, '요술쟁이', {
      flags: flagsHex(MMAGIC),
      spells: spellsWith(SHURTS),
      mpmax: 30,
      mpcur: 30,
      enemies: [P],
      nextActionAt: NEXT_TICK,
    })
    const h = await enterDeathCancelled(follower)
    const hpBefore = h.state(P).hpCurrent
    const expBefore = h.live(P).experience

    // 굴림 예산 3: 시전 확률 1 + 주문 선택 1 + 삭풍 피해 1d8 1(굴린 뒤 HP<1 대상이라 no-op). 근접 굴림 없음.
    combatRngScript.load([CAST_PASS, SPELL_PICK, SHURTS_ROLL])
    h.runCreatureTick()
    expect(combatRngScript.remaining()).toBe(0)

    expect(h.eventsFor(P)).toEqual([
      {
        type: 'combat:round',
        creatureInstanceId: follower.instanceId,
        creatureName: '요술쟁이',
        received: { kind: 'cast', damage: 0 },
        counter: null,
        monsterDied: false,
        youDied: false,
      },
    ])
    expect(h.state(P).hpCurrent).toBe(hpBefore)
    expect(h.live(P).currentRoom).toBe(ARENA)
    expect(h.live(P).experience).toBe(expBefore)
    expect(h.arena.occupants.has(P)).toBe(true)
  })

  it('(c) 근접이 명중해도 다른 플레이어의 반격이 몬스터를 죽이면 다시 취소되어 사망하지 않는다', async () => {
    const follower = monster(`${ARENA}:c1`, '오크', {
      hpmax: 10,
      hpcur: 1,
      enemies: [P, Q],
      nextActionAt: NEXT_TICK,
    })
    const h = await enterDeathCancelled(follower, [player(Q, '을순', ARENA)])
    const hpBefore = h.state(P).hpCurrent
    const expBefore = h.live(P).experience
    const qCounterDamage = expectedCounterDamage(h.state(Q))

    // 굴림 예산 4: 오크 근접 명중 판정 1(P 사망 대기) + Q 반격 명중 3(오크 처치 → 재취소). P는 반격하지 않는다.
    combatRngScript.load([MONSTER_HIT, ...COUNTER_HIT])
    h.runCreatureTick()
    expect(combatRngScript.remaining()).toBe(0)

    const pRound = only(h.eventsFor(P), 'combat:round')
    expect(pRound).toEqual<RoundEvent>({
      type: 'combat:round',
      creatureInstanceId: follower.instanceId,
      creatureName: '오크',
      received: { kind: 'melee', hit: true, damage: 0, critical: false, fumble: false },
      counter: null,
      monsterDied: true,
      youDied: false,
    })
    expect(only(h.eventsFor(Q), 'combat:round').counter).toEqual({
      hit: true,
      damage: qCounterDamage,
      critical: false,
      fumble: false,
    })
    // 사망하지 않았다 — 전투 방에 HP<1인 채 남고 경험치 손실도 없다.
    expect(h.live(P).currentRoom).toBe(ARENA)
    expect(h.arena.occupants.has(P)).toBe(true)
    expect(h.state(P).hpCurrent).toBe(hpBefore)
    expect(h.live(P).experience).toBe(expBefore)
    expect(h.creatureIn(h.arena, follower.instanceId)).toBeUndefined()
  })

  it('D8 빗맞음: received는 melee·hit false·damage 0, 사망 seam 미실행, 원장 기록 없음', async () => {
    const follower = monster(`${ARENA}:c1`, '오크', { enemies: [P], nextActionAt: NEXT_TICK })
    const h = await enterDeathCancelled(follower)
    const hpBefore = h.state(P).hpCurrent
    const expBefore = h.live(P).experience

    // 굴림 예산 1: 오크 근접 명중 판정(rollHit) 빗맞음 1.
    combatRngScript.load([MISS])
    h.runCreatureTick()
    expect(combatRngScript.remaining()).toBe(0)

    // HP·MP 변화도 사망도 없어 combat:round만 받는다.
    expect(h.eventsFor(P)).toEqual([
      {
        type: 'combat:round',
        creatureInstanceId: follower.instanceId,
        creatureName: '오크',
        received: { kind: 'melee', hit: false, damage: 0, critical: false, fumble: false },
        counter: null,
        monsterDied: false,
        youDied: false,
      },
    ])
    expect(h.live(P).currentRoom).toBe(ARENA)
    expect(h.state(P).hpCurrent).toBe(hpBefore)
    expect(h.live(P).experience).toBe(expBefore)
    expect(h.wiring.attackDeps.ledgers.for(follower.instanceId).has(P)).toBe(false)
  })
})
