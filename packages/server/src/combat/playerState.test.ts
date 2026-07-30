import { describe, it, expect, expectTypeOf } from 'vitest'
import { computeAc, computeThaco, type EffectiveStatContext, type Character } from 'shared'
import { toPlayerCombatState, type PlayerCombatState, type WeaponDamage } from './playerState.js'
import type { StudyChar, TeachCaster } from '../magic/learning.js'
import { F_ISSET, PFEARS, PSILNC, PBLIND, PPOISN } from '../world/hexFlags.js'
// 테스트 전용 간선 — 의존 방향 규약은 `character/flags.ts` JSDoc이 정본이다. 여기서는 실제 배선
// 계층이 주입할 hex를 재현해 "합성 → 주입 → F_ISSET 판독" 경로가 끝까지 이어짐을 고정한다.
import { composeCharacterFlags } from '../character/flags.js'

/**
 * playerState 조립 헬퍼 — armor/thaco를 stats-core(computeAc/computeThaco)로 파생하고,
 * base 캐릭터 필드·무기 데미지 서술자를 합성해 라이브 PlayerCombatState를 만든다.
 *
 * 핵심 계약: armor/thaco 재구현 금지 — 주입 effectiveContext로 호출한 stats-core 결과와
 * 정확히 일치해야 한다(값 비교가 아니라 resolver 소비 검증).
 */
describe('toPlayerCombatState', () => {
  const ctx: EffectiveStatContext = {
    effectiveDexterity: 18,
    effectiveStrength: 16,
    equipArmor: 12,
    protection: false,
    characterClass: 4,
    level: 7,
    weaponAdjustment: 2,
    weaponProficiency: 60,
  }

  const character: Character = {
    _id: 'char-1',
    name: '테스토스',
    class: 4,
    race: 1,
    stats: [16, 18, 12, 10, 14],
    gold: 100,
    currentRoom: 1,
    hpCurrent: 42,
    mpCurrent: 15,
    level: 7,
    // 이 픽스처는 PlayerCombatState 어댑트 입력이며 load 경로(backfill)를 거치지 않아 experience는
    // 검증되지 않는다. Character 타입(required) 충족을 위한 최소값 0으로 둔다.
    experience: 0,
    // v5 spell store 시드(빈 지식 비트마스크·realm [0,0,0,0]) — Character required 필드 충족.
    spells: new Array<number>(16).fill(0),
    realm: [0, 0, 0, 0],
    schemaVersion: 2,
    accountId: 'acct-1',
    status: 'active',
    alignment: 1,
  }

  /** 합성 기준 절대 틱 — statusEffects.until >= NOW면 활성이다. */
  const NOW = 100

  /** 침묵·공포가 동시에 활성인 캐릭터 — composeCharacterFlags가 PSILNC·PFEARS를 세운다. */
  const afflicted: Character = {
    ...character,
    statusEffects: { silence: { until: 200 }, fear: { until: 200 } },
  }

  const weapon: WeaponDamage = {
    ndice: 2,
    sdice: 6,
    pdice: 3,
    adjustment: 2,
    proficiency: 60,
  }

  it('armor를 computeAc로 파생한다(재구현 없음)', () => {
    const state = toPlayerCombatState(character, ctx, weapon, '')
    expect(state.armor).toBe(computeAc(ctx))
  })

  it('thaco를 computeThaco로 파생한다(재구현 없음)', () => {
    const state = toPlayerCombatState(character, ctx, weapon, '')
    expect(state.thaco).toBe(computeThaco(ctx))
  })

  it('dexterity를 effectiveContext.effectiveDexterity로 채운다', () => {
    const state = toPlayerCombatState(character, ctx, weapon, '')
    expect(state.dexterity).toBe(ctx.effectiveDexterity)
  })

  it('base 캐릭터 필드를 이식한다(characterId·level·hp·mp)', () => {
    const state = toPlayerCombatState(character, ctx, weapon, '')
    expect(state.characterId).toBe('char-1')
    expect(state.level).toBe(7)
    expect(state.hpCurrent).toBe(42)
    expect(state.mpCurrent).toBe(15)
  })

  it('level은 effectiveContext가 아니라 character.level에서 온다(출처 고정)', () => {
    const leveled: Character = { ...character, level: 9 }
    const ctxDiff: EffectiveStatContext = { ...ctx, level: 3 }
    const state = toPlayerCombatState(leveled, ctxDiff, weapon, '')
    expect(state.level).toBe(9)
  })

  it('alignment 실값을 그대로 이식한다 (v6 required — 폴백은 backfillCharacterV6 소관)', () => {
    // v6에서 alignment가 required가 돼 undefined 케이스는 타입상 불가하다. 부재 문서의 0 시딩은
    // load 경로의 backfillCharacterV6가 소유하므로, 여기서는 실값 이식만 단언한다.
    expect(toPlayerCombatState(character, ctx, weapon, '').alignment).toBe(1)
    const evil: Character = { ...character, alignment: 2 }
    expect(toPlayerCombatState(evil, ctx, weapon, '').alignment).toBe(2)
    const neutral: Character = { ...character, alignment: 0 }
    expect(toPlayerCombatState(neutral, ctx, weapon, '').alignment).toBe(0)
  })

  it('주입된 flags hex를 그대로 이식한다(하드코딩 아님)', () => {
    const injected = composeCharacterFlags(afflicted, NOW)
    const state = toPlayerCombatState(character, ctx, weapon, injected)
    expect(state.flags).toBe(injected)
  })

  it('침묵·공포 캐릭터의 합성 hex를 주입하면 PSILNC·PFEARS가 선다', () => {
    // 배선 계층이 하는 일(composeCharacterFlags(character, now))을 재현해 주입한다 — 조립 헬퍼는
    // now를 모르며 합성 결과 hex만 받는다.
    const state = toPlayerCombatState(character, ctx, weapon, composeCharacterFlags(afflicted, NOW))
    expect(F_ISSET(state.flags, PSILNC)).toBe(true)
    expect(F_ISSET(state.flags, PFEARS)).toBe(true)
    // 소유 비트 밖(미부여 상태이상)은 서지 않는다 — 주입 hex를 통째로 싣는지 확인하는 대조군.
    expect(F_ISSET(state.flags, PBLIND)).toBe(false)
    expect(F_ISSET(state.flags, PPOISN)).toBe(false)
  })

  it('빈 hex를 주입하면 어느 P-flag도 세팅되지 않는다(신선한 플레이어)', () => {
    const state = toPlayerCombatState(character, ctx, weapon, '')
    expect(state.flags).toBe('')
    expect(F_ISSET(state.flags, PFEARS)).toBe(false)
    expect(F_ISSET(state.flags, PSILNC)).toBe(false)
    expect(F_ISSET(state.flags, PBLIND)).toBe(false)
  })

  it('flags 재대입은 타입 레벨에서 거부된다(반환 객체를 freeze하진 않는다)', () => {
    const state = toPlayerCombatState(character, ctx, weapon, '')
    // 검증 채널은 vitest가 아니라 tsc다 — readonly가 사라지면 이 지시자가 unused가 돼 tsc가 실패한다.
    // 런타임에는 막지 않는다(hpCurrent/nextAttackAt의 가변 carve-out과 같은 객체다). 만료로 비트가
    // 내려가야 하면 재조립이 정본 경로다.
    // @ts-expect-error flags는 readonly — 라운드 중 라이브 mutation 경로를 두지 않는다.
    state.flags = 'ffffffffffffffff'
  })

  it('class를 character.class로 채운다(피해 분기 소비)', () => {
    const state = toPlayerCombatState(character, ctx, weapon, '')
    expect(state.class).toBe(4)
  })

  it('effectiveStrength를 effectiveContext에서 채운다(bonus[str] 소비)', () => {
    const state = toPlayerCombatState(character, ctx, weapon, '')
    expect(state.effectiveStrength).toBe(ctx.effectiveStrength)
  })

  it('effectiveIntelligence를 character.stats[3](intelligence)에서 소싱한다(#84 base==effective)', () => {
    // stats 튜플 순서: strength0·dexterity1·constitution2·intelligence3·piety4. 픽스처 stats[3]=10.
    const state = toPlayerCombatState(character, ctx, weapon, '')
    expect(state.effectiveIntelligence).toBe(10)
  })

  it('무기 미착용이면 weapon을 null로 이식한다(맨손 분기)', () => {
    const state = toPlayerCombatState(character, ctx, null, '')
    expect(state.weapon).toBeNull()
  })

  it('무기 데미지 서술자를 중첩 weapon으로 이식한다(mdice 소비 편의)', () => {
    const state = toPlayerCombatState(character, ctx, weapon, '')
    expect(state.weapon).toEqual({
      ndice: 2,
      sdice: 6,
      pdice: 3,
      adjustment: 2,
      proficiency: 60,
    })
  })

  it('nextAttackAt을 0으로 초기화한다(LT_ATTCK 반격 쿨다운 게이트)', () => {
    const state = toPlayerCombatState(character, ctx, weapon, '')
    expect(state.nextAttackAt).toBe(0)
  })

  it('가변 필드를 in-place 차감할 수 있다(readonly 아님)', () => {
    const state = toPlayerCombatState(character, ctx, weapon, '')
    state.hpCurrent -= 10
    state.nextAttackAt = 5
    expect(state.hpCurrent).toBe(32)
    expect(state.nextAttackAt).toBe(5)
  })

  it('Character.spells 비트마스크를 실이식한다(#85 — 빈 스텁 아님)', () => {
    const known = new Array<number>(16).fill(0)
    known[0] = 0b1000000 // 비트6(주문번호 6) 세팅
    const withSpells: Character = { ...character, spells: known }
    const state = toPlayerCombatState(withSpells, ctx, weapon, '')
    expect(state.spells).toEqual(known)
  })

  it('Character.realm 누적경험치를 실이식한다(#85 — [0,0,0,0] 스텁 아님)', () => {
    const withRealm: Character = { ...character, realm: [11, 22, 33, 44] }
    const state = toPlayerCombatState(withRealm, ctx, weapon, '')
    expect(state.realm).toEqual([11, 22, 33, 44])
  })
})

/**
 * 학습 게이트 입력 재사용 계약(타입 레벨) — pvp.test.ts의 게이트 입력 계약 선례와 동형이다.
 *
 * `study`/`teach`는 최소 구조 shape(StudyChar·TeachCaster)을 받는다. flags가 주입 배선을 얻은 지금
 * PlayerCombatState가 두 shape을 구조적으로 만족하므로, 배선 계층은 어댑터를 끼우지 않고 라이브
 * 전투상태를 그대로 넘길 수 있다. 이 할당성이 깨지면(예: flags 타입 변경, alignment optional 회귀)
 * 배선 시점이 아니라 여기서 컴파일 실패로 드러난다.
 *
 * expectTypeOf는 런타임에 소거되므로 이 단언의 검증 채널은 `tsc --noEmit`이다(vitest run 아님).
 */
describe('학습 게이트 입력 재사용 계약(타입 레벨)', () => {
  it('PlayerCombatState가 StudyChar·TeachCaster에 구조적으로 할당된다', () => {
    // StudyChar: level·class·alignment·spells·flags
    expectTypeOf<PlayerCombatState>().toMatchTypeOf<StudyChar>()
    // TeachCaster: class·spells·flags
    expectTypeOf<PlayerCombatState>().toMatchTypeOf<TeachCaster>()
  })
})
