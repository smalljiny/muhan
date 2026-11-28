import { describe, it, expect, vi } from 'vitest'
import { resolveHpMax, resolveMpMax } from 'shared'

// 굴림 결정성 — wiring이 `defaultCombatRng`를 하드코딩하므로(D4 — 묶음에 rng seam을 뚫지 않는다) 그 export만
// 스크립트 큐로 바꾼다(`.harness/rules/testing.md` "비즈니스 로직 mock 금지"의 문서화된 예외 — combatWiring.test.ts
// 관례). 나머지 dice export(dice·mdice)는 실제 구현 그대로다.
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
  PLAYER_HIT,
  MISS,
  NO_CRIT,
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
  expectedMonsterDamage,
  expectedCounterDamage,
  useTrackedHarness,
  type RoundEvent,
  type StatsEvent,
} from './creatureTickLiveWorld.testutil.js'
import { createAttackHandler } from './handlers/attack.js'
import { assemblePlayerCombatState } from '../combat/assemblePlayerCombatState.js'
import { hitThreshold } from '../combat/attackStats.js'
import { toCombatant } from '../combat/combatant.js'
import { ATTACK_COOLDOWN_INTERVAL, FIGHTER } from '../combat/constants.js'
import { applyPlayerDeath } from '../progression/death.js'
import { F_ISSET, MMAGIC, PUPDMG, PBLIND, PFEARS } from '../world/hexFlags.js'
import { flagsHex } from '../world/roomFixtures.testutil.js'

/**
 * 몬스터 전투 tick 프로덕션 조립 통합 테스트(스펙 G4) — 바인딩 슬롯 + `createWorldRuntime` +
 * `createLiveWorldWiring`을 boot와 같은 순서로 조립하고(`creatureTickLiveWorld.testutil.ts`), 크리처 tick
 * 슬롯을 수동 실행해 라운드 → 통지 → 사망·부활까지 한 경로로 관통한다.
 *
 * 단위 테스트(combatTick·combatRoundNotifier·assembleDeathSeams·creatureTick)는 각 seam을 고정했다. 이
 * 파일은 그 사이의 연결 — 슬롯이 실제 핸들러로 위임되는지, 통지기가 실제 레지스트리·활성 집합·presence를
 * 보는지 — 를 검증한다.
 *
 * 굴림 예산: 각 `it`이 소비할 굴림을 주석으로 적고 큐에 그대로 적재한 뒤 잔여 0을 단언한다. 큐는 소진·범위
 * 밖 값에 throw하므로 예산 초과·순서 어긋남은 즉시 실패한다. 확률에 기대는 단언은 없다.
 *
 * 사망 취소(D8)와 다인 라운드 와이어 값은 `creatureTickLiveWorld.deathCancel.integration.test.ts`·
 * `creatureTickLiveWorld.multiRecipient.integration.test.ts`가 같은 하네스로 다룬다.
 */

const P = 'char-p'
const Q = 'char-q'
const O = 'char-o'
const R = 'char-r'

/** 하네스 생성 — afterEach가 송신 이벤트 전체의 와이어 스키마를 검사하고 굴림 큐를 비운다. */
const harness = useTrackedHarness()

describe('몬스터 전투 tick 프로덕션 조립 — 결정성 전제', () => {
  it('굴림 값 상수가 프로덕션 공식에서 명중·빗맞음·크리 없음을 강제한다', async () => {
    const h = harness({ seeds: [player(P, '갑돌', ARENA)] })
    await h.enter(P)
    const state = h.state(P)
    const m = monster(`${ARENA}:c0`, '고블린')

    // 몬스터 → 플레이어: 명중 조건은 rng(1,20) >= 임계(rollHit).
    const monsterThreshold = hitThreshold(toCombatant(m), toCombatant(state))
    expect(MONSTER_HIT).toBeGreaterThanOrEqual(monsterThreshold)
    expect(MISS).toBeLessThan(monsterThreshold)
    // 플레이어 → 몬스터: rng(1,30) >= 임계. P-flag(PFEARS +2·PBLIND +5)가 없어야 임계가 유지된다.
    const playerThreshold = hitThreshold(toCombatant(state), toCombatant(m))
    expect(PLAYER_HIT).toBeGreaterThanOrEqual(playerThreshold)
    expect(MISS).toBeLessThan(playerThreshold)
    expect(F_ISSET(state.flags, PFEARS)).toBe(false)
    expect(F_ISSET(state.flags, PBLIND)).toBe(false)
    // 반격 굴림 수 = 명중·피해(FIGHTER 1d5 한 번)·크리 3개: 맨손(숙련 p=0 → 크리 불가, 불발·내구도 굴림 없음),
    // PUPDMG 없음(다중공격 굴림 없음), MAGE/CLERIC 재굴림 없음.
    expect(state.weapon).toBeNull()
    expect(state.class).toBe(FIGHTER)
    expect(F_ISSET(state.flags, PUPDMG)).toBe(false)
    expect(NO_CRIT).toBeGreaterThan(0)
    // 몬스터 근접 피해는 주사위가 없어 굴림 없이 정해지고, 기본 HP 42 플레이어가 한 대에 죽지 않는다.
    expect(expectedMonsterDamage(m, state)).toBeLessThan(state.hpCurrent)
    expect(expectedCounterDamage(state)).toBeGreaterThan(0)
    expect(F_ISSET(m.flags, MMAGIC)).toBe(false)
  })
})

describe('몬스터 전투 tick 프로덕션 조립 — 피해·사망', () => {
  it('활성 몬스터의 근접 피해가 표적에게만 combat:round·character:stats로 가고 저장된다', async () => {
    const m = monster(`${ARENA}:c0`, '고블린', { enemies: [P] })
    const h = harness({
      arenaCreatures: [m],
      seeds: [player(P, '갑돌', ARENA), player(O, '구경꾼', ARENA)],
    })
    await h.enter(P)
    await h.enter(O)
    h.clearSent()
    const hpBefore = h.state(P).hpCurrent
    const damage = expectedMonsterDamage(m, h.state(P))

    // 굴림 예산 2: 몬스터 근접 명중 1 + P 반격 빗맞음 1.
    combatRngScript.load([MONSTER_HIT, MISS])
    h.runCreatureTick()
    expect(combatRngScript.remaining()).toBe(0)

    const events = h.eventsFor(P)
    expect(events.map((e) => e.type)).toEqual(['combat:round', 'character:stats'])
    const round = only(events, 'combat:round')
    expect(round).toEqual<RoundEvent>({
      type: 'combat:round',
      creatureInstanceId: m.instanceId,
      creatureName: '고블린',
      received: { kind: 'melee', hit: true, damage, critical: false, fumble: false },
      counter: { hit: false, damage: 0, critical: false, fumble: false },
      monsterDied: false,
      youDied: false,
    })
    expect(h.state(P).hpCurrent).toBe(hpBefore - damage)
    expect(only(events, 'character:stats').hpCurrent).toBe(hpBefore - damage)
    // 생존 상태 변경자 되쓰기 — 저장 스냅샷과 라이브 문서가 같은 HP를 싣는다.
    expect(h.live(P).hpCurrent).toBe(hpBefore - damage)
    expect(h.lastSaved(P)?.hpCurrent).toBe(hpBefore - damage)
    // 라운드 수신자·상태 변경자가 아닌 같은 방 점유자는 아무것도 받지 않는다(G2 표).
    expect(h.eventsFor(O)).toEqual([])
  })

  it('근접 치사: 표적의 반격 뒤 라운드 끝 사망 1회 → 1008 부활·풀회복·경험치 손실(§3.4 순서)', async () => {
    const m = monster(`${ARENA}:c0`, '고블린', { enemies: [P] })
    const h = harness({
      arenaCreatures: [m],
      seeds: [
        player(P, '갑돌', ARENA, { hpCurrent: 1, experience: RICH_EXP }),
        player(O, '구경꾼', ARENA),
        player(R, '순례자', REVIVE),
      ],
    })
    await h.enter(P)
    await h.enter(O)
    await h.enter(R)
    h.clearSent()
    const oldState = h.state(P)
    const liveBefore = h.live(P)
    const damage = expectedMonsterDamage(m, oldState)
    const counterDamage = expectedCounterDamage(oldState)

    // 굴림 예산 4: 몬스터 근접 명중 1(표적 HP<1 → 사망 대기) + P 반격 명중 3(명중·피해·크리).
    combatRngScript.load([MONSTER_HIT, ...COUNTER_HIT])
    h.runCreatureTick()
    expect(combatRngScript.remaining()).toBe(0)

    // §3.4 순서: combat:round → character:stats(부활 후 값) → 부활 방 world:room.
    const events = h.eventsFor(P)
    expect(events.map((e) => e.type)).toEqual(['combat:round', 'character:stats', 'world:room'])
    expect(events[0]).toEqual<RoundEvent>({
      type: 'combat:round',
      creatureInstanceId: m.instanceId,
      creatureName: '고블린',
      received: { kind: 'melee', hit: true, damage, critical: false, fumble: false },
      counter: { hit: true, damage: counterDamage, critical: false, fumble: false },
      monsterDied: false,
      youDied: true,
    })
    const revived = applyPlayerDeath(liveBefore)
    expect(revived.experience).toBeLessThan(RICH_EXP)
    expect(events[1]).toMatchObject<Partial<StatsEvent>>({
      type: 'character:stats',
      hpCurrent: resolveHpMax(liveBefore),
      mpCurrent: resolveMpMax(liveBefore),
      // 사망 1회 — 경험치 손실이 정확히 한 번 적용된 값이다.
      experience: revived.experience,
    })
    const revivalView = only(events, 'world:room')
    expect(revivalView.roomId).toBe(REVIVE)
    expect(revivalView.occupants.map((o) => o.characterId)).toContain(P)

    // presence: 출발 방 점유자는 exited, 부활 방 점유자는 entered를 받는다.
    expect(h.eventsFor(O)).toEqual([
      expect.objectContaining({
        type: 'world:presence',
        roomId: ARENA,
        change: { change: 'exited', announce: false },
      }),
    ])
    expect(h.eventsFor(R)).toEqual([
      expect.objectContaining({ type: 'world:presence', roomId: REVIVE }),
    ])
    expect(only(h.eventsFor(R), 'world:presence').change.change).toBe('entered')

    // 부활 방 배치·풀회복 — 라이브 문서·점유·저장 스냅샷·새 전투상태.
    expect(h.live(P).currentRoom).toBe(REVIVE)
    expect(h.revive.occupants.has(P)).toBe(true)
    expect(h.arena.occupants.has(P)).toBe(false)
    expect(h.lastSaved(P)).toMatchObject({ currentRoom: REVIVE, experience: revived.experience })
    const newState = h.state(P)
    expect(newState).not.toBe(oldState)
    expect(newState.hpCurrent).toBe(resolveHpMax(liveBefore))
    // 반격 직후 같은 라운드 end-of-round 사망: 새 전투상태가 반격으로 갱신된 쿨다운을 이어받는다.
    expect(oldState.nextAttackAt).toBe(START_TICK + ATTACK_COOLDOWN_INTERVAL)
    expect(newState.nextAttackAt).toBe(oldState.nextAttackAt)
    // 몬스터는 반격 피해만 입고 살아 있으며, 적 목록에서 사망자가 빠졌다(del_enm_crt).
    const after = h.creatureIn(h.arena, m.instanceId)
    expect(after?.hpcur).toBe(1000 - counterDamage)
    expect(after?.enemies).not.toContain(P)
  })

  it('시전 치사(MMAGIC): combat:round 1건(cast·실제 차감량·youDied) → 부활 후 stats → 부활 방 world:room, 반격 없음', async () => {
    const m = monster(`${ARENA}:c0`, '요술쟁이', {
      flags: flagsHex(MMAGIC),
      spells: spellsWith(SHURTS),
      mpmax: 30,
      mpcur: 30,
      enemies: [P],
    })
    const h = harness({
      arenaCreatures: [m],
      seeds: [player(P, '갑돌', ARENA, { hpCurrent: 1, experience: RICH_EXP })],
    })
    await h.enter(P)
    h.clearSent()
    const oldState = h.state(P)
    const hpBefore = oldState.hpCurrent
    const liveBefore = h.live(P)

    // 굴림 예산 3: 시전 확률 1(통과) + 주문 선택 1(아는 주문 1개) + 삭풍 피해 1d8 1. 시전 치사(D7)로
    // 근접·반격 굴림이 없다 — 큐가 4번째 굴림에 throw하므로 반격이 있었다면 여기서 실패한다.
    combatRngScript.load([CAST_PASS, SPELL_PICK, SHURTS_ROLL])
    h.runCreatureTick()
    expect(combatRngScript.remaining()).toBe(0)

    const events = h.eventsFor(P)
    expect(events.map((e) => e.type)).toEqual(['combat:round', 'character:stats', 'world:room'])
    const round = only(events, 'combat:round')
    // 피해 = 시전 전후 옛 전투상태 객체의 HP 차이(D5) — 사망 seam은 옛 객체를 바꾸지 않는다.
    const actualLoss = hpBefore - oldState.hpCurrent
    expect(actualLoss).toBeGreaterThan(0)
    expect(round).toEqual<RoundEvent>({
      type: 'combat:round',
      creatureInstanceId: m.instanceId,
      creatureName: '요술쟁이',
      received: { kind: 'cast', damage: actualLoss },
      counter: null,
      monsterDied: false,
      youDied: true,
    })
    const revived = applyPlayerDeath(liveBefore)
    expect(events[1]).toMatchObject<Partial<StatsEvent>>({
      type: 'character:stats',
      hpCurrent: resolveHpMax(liveBefore),
      mpCurrent: resolveMpMax(liveBefore),
      experience: revived.experience, // 사망 1회
    })
    expect(only(events, 'world:room').roomId).toBe(REVIVE)

    // 반격 없음 — 몬스터 HP 불변, 옛 상태의 반격 쿨다운 미갱신.
    expect(h.creatureIn(h.arena, m.instanceId)?.hpcur).toBe(1000)
    expect(oldState.nextAttackAt).toBe(0)
    // 부활 방 배치와 풀회복.
    const live = h.live(P)
    expect(live.currentRoom).toBe(REVIVE)
    expect(h.revive.occupants.has(P)).toBe(true)
    expect(h.arena.occupants.has(P)).toBe(false)
    expect(live.hpCurrent).toBe(resolveHpMax(live))
    expect(live.mpCurrent).toBe(resolveMpMax(live))
    expect(h.state(P).hpCurrent).toBe(resolveHpMax(live))
    expect(h.state(P).mpCurrent).toBe(resolveMpMax(live))
  })

  it('같은 방 사망(1008에서 사망): presence 없이 풀회복과 본인 world:room만 처리한다', async () => {
    const m = monster(`${REVIVE}:c0`, '고블린', { enemies: [P] })
    const h = harness({
      reviveCreatures: [m],
      seeds: [
        player(P, '갑돌', REVIVE, { hpCurrent: 1, experience: RICH_EXP }),
        player(O, '구경꾼', REVIVE),
      ],
    })
    await h.enter(P)
    await h.enter(O)
    h.clearSent()
    const liveBefore = h.live(P)

    // 굴림 예산 2: 몬스터 근접 명중 1(사망 대기) + P 반격 빗맞음 1.
    combatRngScript.load([MONSTER_HIT, MISS])
    h.runCreatureTick()
    expect(combatRngScript.remaining()).toBe(0)

    expect(h.eventsFor(P).map((e) => e.type)).toEqual([
      'combat:round',
      'character:stats',
      'world:room',
    ])
    expect(only(h.eventsFor(P), 'combat:round').youDied).toBe(true)
    expect(only(h.eventsFor(P), 'world:room').roomId).toBe(REVIVE)
    expect(only(h.eventsFor(P), 'character:stats').hpCurrent).toBe(resolveHpMax(liveBefore))
    // presence 0건 — 점유 변화가 없다.
    expect(h.allSent().filter(([, e]) => e.type === 'world:presence')).toEqual([])
    expect(h.eventsFor(O)).toEqual([])
    expect([...h.revive.occupants].sort()).toEqual([O, P].sort())
    expect(h.live(P).currentRoom).toBe(REVIVE)
    expect(h.live(P).hpCurrent).toBe(resolveHpMax(liveBefore))
    expect(h.worldRuntime.activeSet.isActive(REVIVE)).toBe(true)
  })

  it('출발 방 동결: 마지막 점유자 사망 뒤 같은 tick의 후속 몬스터는 hp·mp·nextActionAt이 그대로다', async () => {
    const killer = monster(`${ARENA}:c0`, '고블린', { enemies: [P] })
    // 재생이 도래한 상태(hp·mp 최대 미만, lastRegenAt+60 <= now)이고 행동도 도래했다 — 처리됐다면 재생되고
    // nextActionAt이 재스케줄된다.
    const follower = monster(`${ARENA}:c1`, '오크', {
      hpcur: 500,
      mpmax: 30,
      mpcur: 0,
      lastRegenAt: START_TICK - 60,
      nextActionAt: START_TICK,
      enemies: [P],
    })
    const h = harness({
      arenaCreatures: [killer, follower],
      seeds: [player(P, '갑돌', ARENA, { hpCurrent: 1 })],
    })
    await h.enter(P)
    expect(h.worldRuntime.activeSet.isActive(ARENA)).toBe(true)

    // 굴림 예산 2: 앞 몬스터 근접 명중 1 + P 반격 빗맞음 1. 후속 몬스터는 굴림을 소비하지 않는다.
    combatRngScript.load([MONSTER_HIT, MISS])
    h.runCreatureTick()
    expect(combatRngScript.remaining()).toBe(0)

    expect(h.live(P).currentRoom).toBe(REVIVE)
    expect(h.worldRuntime.activeSet.isActive(ARENA)).toBe(false)
    // autonomic이 몬스터 객체를 교체하므로 tick 뒤 방 배열에서 instanceId로 다시 찾는다.
    const after = h.creatureIn(h.arena, follower.instanceId)
    expect(after).toBeDefined()
    expect(after?.hpcur).toBe(500)
    expect(after?.mpcur).toBe(0)
    expect(after?.nextActionAt).toBe(START_TICK)
  })
})

describe('몬스터 전투 tick 프로덕션 조립 — 보상·방 뷰·수집 격리', () => {
  it('반격 처치 보상: 피해 없는 처치자의 저장 경험치·stats가 늘고, 같은 방 다른 기여자도 stats를 받는다', async () => {
    const pSeed = player(P, '갑돌', ARENA)
    const qSeed = player(Q, '을순', ARENA)
    // P·Q는 같은 클래스·능력치라 같은 굴림의 타격 피해가 같다. 몬스터 HP를 그 2배로 두면 Q 오프너에 살아남고
    // P 반격에 죽는다(피해는 프로덕션 공식으로 산출 — 맨손이라 장비 인덱스·플래그는 피해에 관여하지 않는다).
    const strike = expectedCounterDamage(
      assemblePlayerCombatState({ character: qSeed, inventory: [] }, new Map(), ''),
    )
    const m = monster(`${ARENA}:c0`, '고블린', { hpmax: 10, hpcur: 2 * strike, enemies: [P] })
    const h = harness({ arenaCreatures: [m], seeds: [pSeed, qSeed] })
    await h.enter(P)
    await h.enter(Q)

    // Q 오프너 굴림 예산 3: 명중·피해·크리 → 몬스터 생존, Q가 원장 기여자·적 목록 뒤쪽에 오르고
    // 반격 쿨다운(nextAttackAt = now + 1)이 걸린다.
    combatRngScript.load([...COUNTER_HIT])
    createAttackHandler(h.wiring.attackDeps)(
      { type: 'combat:attack', target: '고블린' },
      { accountId: `acct-${Q}`, characterId: Q },
    )
    expect(combatRngScript.remaining()).toBe(0)
    expect(h.creatureIn(h.arena, m.instanceId)?.hpcur).toBe(strike)
    expect(h.creatureIn(h.arena, m.instanceId)?.enemies).toEqual([P, Q])
    expect(h.state(Q).nextAttackAt).toBeGreaterThan(START_TICK)
    h.clearSent()
    const pBefore = h.live(P)
    const qBefore = h.live(Q)

    // tick 굴림 예산 4: 몬스터 근접 P 빗맞음 1 + (Q 쿨다운 스킵) + P 반격 명중 3 → 몬스터 사망.
    combatRngScript.load([MISS, ...COUNTER_HIT])
    h.runCreatureTick()
    expect(combatRngScript.remaining()).toBe(0)

    const round = only(h.eventsFor(P), 'combat:round')
    expect(round.received).toEqual({
      kind: 'melee',
      hit: false,
      damage: 0,
      critical: false,
      fumble: false,
    })
    expect(round.counter?.hit).toBe(true)
    expect(round.monsterDied).toBe(true)
    expect(round.youDied).toBe(false)
    // 처치자: 피해 없음(HP 불변) + 경험치 증가가 stats와 저장 스냅샷 모두에 실린다.
    const pStats = only(h.eventsFor(P), 'character:stats')
    expect(pStats.hpCurrent).toBe(pBefore.hpCurrent)
    expect(pStats.experience).toBeGreaterThan(pBefore.experience)
    expect(h.live(P).experience).toBe(pStats.experience)
    expect(h.lastSaved(P)?.experience).toBe(pStats.experience)
    expect(h.lastSaved(P)?.hpCurrent).toBe(pBefore.hpCurrent)
    // 같은 방 다른 기여자(라운드 수신자 아님): stats 1건만 받는다.
    expect(h.eventsFor(Q).map((e) => e.type)).toEqual(['character:stats'])
    expect(only(h.eventsFor(Q), 'character:stats').experience).toBeGreaterThan(qBefore.experience)
    expect(h.lastSaved(Q)?.experience).toBe(h.live(Q).experience)
  })

  it('방 뷰 갱신: 반격으로 몬스터가 죽으면 당사자가 받은 world:room에 그 몬스터가 없다', async () => {
    const m = monster(`${ARENA}:c0`, '고블린', { hpmax: 10, hpcur: 1, enemies: [P] })
    const bystander = monster(`${ARENA}:c1`, '다람쥐')
    const h = harness({ arenaCreatures: [m, bystander], seeds: [player(P, '갑돌', ARENA)] })
    await h.enter(P)
    h.clearSent()

    // 굴림 예산 4: 몬스터 근접 빗맞음 1 + P 반격 명중 3(처치). 적 없는 비공격형 몬스터는 전투 디스패치가 없다.
    combatRngScript.load([MISS, ...COUNTER_HIT])
    h.runCreatureTick()
    expect(combatRngScript.remaining()).toBe(0)

    const events = h.eventsFor(P)
    expect(events.map((e) => e.type)).toEqual(['combat:round', 'character:stats', 'world:room'])
    const view = only(events, 'world:room')
    expect(view.roomId).toBe(ARENA)
    expect(view.creatures.map((c) => c.instanceId)).toEqual([bystander.instanceId])
    expect(h.creatureIn(h.arena, m.instanceId)).toBeUndefined()
  })

  it('오프너 수집 격리: 오프너 처치 직후 다른 몬스터 tick에서 오프너 수령자가 stats를 추가로 받지 않는다', async () => {
    const prey = monster(`${ARENA}:c0`, '들쥐', { hpmax: 1, hpcur: 1 })
    const other = monster(`${ARENA}:c1`, '고블린', { enemies: [Q] })
    const h = harness({
      arenaCreatures: [prey, other],
      seeds: [player(P, '갑돌', ARENA), player(Q, '을순', ARENA)],
    })
    await h.enter(P)
    await h.enter(Q)
    const attack = createAttackHandler(h.wiring.attackDeps)

    // 오프너 굴림 예산 3: P 공격 명중 3(명중·피해·크리) → 들쥐 처치, P가 경험치 수령.
    combatRngScript.load([...COUNTER_HIT])
    attack({ type: 'combat:attack', target: '들쥐' }, { accountId: `acct-${P}`, characterId: P })
    expect(combatRngScript.remaining()).toBe(0)
    expect(h.creatureIn(h.arena, prey.instanceId)).toBeUndefined()
    expect(h.live(P).experience).toBeGreaterThan(0)
    h.clearSent()

    // tick 굴림 예산 2: 고블린 근접 Q 빗맞음 1 + Q 반격 빗맞음 1.
    combatRngScript.load([MISS, MISS])
    h.runCreatureTick()
    expect(combatRngScript.remaining()).toBe(0)

    // 수집기가 오프너 처치를 기록했다면 이 라운드 통지가 P에게 character:stats를 덧보낸다.
    expect(h.eventsFor(P)).toEqual([])
    expect(h.eventsFor(Q).map((e) => e.type)).toEqual(['combat:round'])
  })
})
