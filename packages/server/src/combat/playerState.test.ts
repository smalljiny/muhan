import { describe, it, expect } from 'vitest'
import { computeAc, computeThaco, type EffectiveStatContext, type Character } from 'shared'
import { toPlayerCombatState, type WeaponDamage } from './playerState.js'
import { F_ISSET, PFEARS } from '../world/hexFlags.js'

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

  const weapon: WeaponDamage = {
    ndice: 2,
    sdice: 6,
    pdice: 3,
    adjustment: 2,
    proficiency: 60,
  }

  it('armor를 computeAc로 파생한다(재구현 없음)', () => {
    const state = toPlayerCombatState(character, ctx, weapon)
    expect(state.armor).toBe(computeAc(ctx))
  })

  it('thaco를 computeThaco로 파생한다(재구현 없음)', () => {
    const state = toPlayerCombatState(character, ctx, weapon)
    expect(state.thaco).toBe(computeThaco(ctx))
  })

  it('dexterity를 effectiveContext.effectiveDexterity로 채운다', () => {
    const state = toPlayerCombatState(character, ctx, weapon)
    expect(state.dexterity).toBe(ctx.effectiveDexterity)
  })

  it('base 캐릭터 필드를 이식한다(characterId·level·hp·mp)', () => {
    const state = toPlayerCombatState(character, ctx, weapon)
    expect(state.characterId).toBe('char-1')
    expect(state.level).toBe(7)
    expect(state.hpCurrent).toBe(42)
    expect(state.mpCurrent).toBe(15)
  })

  it('level은 effectiveContext가 아니라 character.level에서 온다(출처 고정)', () => {
    const leveled: Character = { ...character, level: 9 }
    const ctxDiff: EffectiveStatContext = { ...ctx, level: 3 }
    const state = toPlayerCombatState(leveled, ctxDiff, weapon)
    expect(state.level).toBe(9)
  })

  it('alignment를 character.alignment로 채운다', () => {
    const state = toPlayerCombatState(character, ctx, weapon)
    expect(state.alignment).toBe(1)
  })

  it('alignment 미설정이면 0으로 기본한다', () => {
    const noAlign: Character = { ...character, alignment: undefined }
    const state = toPlayerCombatState(noAlign, ctx, weapon)
    expect(state.alignment).toBe(0)
  })

  it('flags를 빈 hex로 기본한다(creature flags와 동일 표현)', () => {
    const state = toPlayerCombatState(character, ctx, weapon)
    expect(state.flags).toBe('')
  })

  it('신선한 플레이어는 상태 플래그가 없다(F_ISSET false)', () => {
    const state = toPlayerCombatState(character, ctx, weapon)
    expect(F_ISSET(state.flags, PFEARS)).toBe(false)
  })

  it('class를 character.class로 채운다(피해 분기 소비)', () => {
    const state = toPlayerCombatState(character, ctx, weapon)
    expect(state.class).toBe(4)
  })

  it('effectiveStrength를 effectiveContext에서 채운다(bonus[str] 소비)', () => {
    const state = toPlayerCombatState(character, ctx, weapon)
    expect(state.effectiveStrength).toBe(ctx.effectiveStrength)
  })

  it('effectiveIntelligence를 character.stats[3](intelligence)에서 소싱한다(#84 base==effective)', () => {
    // stats 튜플 순서: strength0·dexterity1·constitution2·intelligence3·piety4. 픽스처 stats[3]=10.
    const state = toPlayerCombatState(character, ctx, weapon)
    expect(state.effectiveIntelligence).toBe(10)
  })

  it('무기 미착용이면 weapon을 null로 이식한다(맨손 분기)', () => {
    const state = toPlayerCombatState(character, ctx, null)
    expect(state.weapon).toBeNull()
  })

  it('무기 데미지 서술자를 중첩 weapon으로 이식한다(mdice 소비 편의)', () => {
    const state = toPlayerCombatState(character, ctx, weapon)
    expect(state.weapon).toEqual({
      ndice: 2,
      sdice: 6,
      pdice: 3,
      adjustment: 2,
      proficiency: 60,
    })
  })

  it('nextAttackAt을 0으로 초기화한다(LT_ATTCK 반격 쿨다운 게이트)', () => {
    const state = toPlayerCombatState(character, ctx, weapon)
    expect(state.nextAttackAt).toBe(0)
  })

  it('가변 필드를 in-place 차감할 수 있다(readonly 아님)', () => {
    const state = toPlayerCombatState(character, ctx, weapon)
    state.hpCurrent -= 10
    state.nextAttackAt = 5
    expect(state.hpCurrent).toBe(32)
    expect(state.nextAttackAt).toBe(5)
  })
})
