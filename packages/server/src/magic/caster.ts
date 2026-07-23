import { bonusOf, isKnown, type CreatureInstance } from 'shared'
import type { PlayerCombatState } from '../combat/playerState.js'
import { F_ISSET } from '../world/hexFlags.js'

/**
 * Caster — 몹(CreatureInstance)·플레이어(PlayerCombatState) 공유 시전 추상.
 *
 * ## 계약 경계 (#84·#85·#86 공유 — 정확히 6필드, 그 이상 노출 금지)
 * 이 6필드로 시전 게이트·spell_fail·데미지 bns가 완결된다. 계약은 다음을 **포함하지 않는다**:
 *   - realm-growth write(addrealm)·학습 write(study/teach) → #85 소관.
 *   - delivery 아이템 본체(scroll/potion/wand) → #86 소관.
 * 필드를 더하지 마라 — 계약 경계가 무너지면 하위 토픽이 잘못된 표면에 결합한다.
 *
 * mpCurrent만 가변(S4가 `caster.mpCurrent -= N`으로 마나 소비)이고, 나머지는 읽기 전용이다.
 */
export interface Caster {
  /** 현재 MP — 읽기 + 소비. 라이브 소스에 write-through 된다(toCaster의 get/set 바인딩). */
  mpCurrent: number
  /** 레벨 — spell_fail L4·mprofic 입력(읽기). */
  readonly level: number
  /** realm별 숙련(길이 4, 읽기) — 플레이어는 캐릭터 영속 realm, 몹은 creature.realm. */
  readonly realm: readonly number[]
  /** 직업 인덱스(읽기). */
  readonly class: number
  /** bonusOf(intelligence) 사전 계산값(읽기) — 데미지 bns 입력. */
  readonly intBonus: number
  /** S_ISSET 판독 — 해당 주문을 보유하는지(읽기). */
  knows(spellNo: number): boolean
}

/**
 * CreatureInstance를 Caster로 어댑트한다. mpCurrent는 creature.mpcur에 write-through 바인딩한다.
 *
 * ⚠️ 가변 carve-out: coding-style immutability 원칙과 달리 mpCurrent get/set은 라이브 소스에
 * **의도적으로 바인딩**한다 — S4의 `caster.mpCurrent -= N`이 실 MP를 감소시켜야 하며(스냅샷이면
 * 소비가 유실됨), worldGraph 승인 가변 선례(CreatureInstance 라이브 필드 in-place 갱신)와 동류다.
 */
export function toCaster(creature: CreatureInstance): Caster
/**
 * PlayerCombatState를 Caster로 어댑트한다. mpCurrent는 state.mpCurrent에 write-through 바인딩한다.
 *
 * realm·knows는 #85가 실 spell store(state.realm·state.spells)로 잇는다 — #84의 [0,0,0,0]·false
 * 스텁을 대체해 학습 지식·realm 숙련이 실제 캐릭터 영속값을 반영한다.
 */
export function toCaster(player: PlayerCombatState): Caster
export function toCaster(source: CreatureInstance | PlayerCombatState): Caster {
  // 런타임 판별 — CreatureInstance는 mpcur, PlayerCombatState는 mpCurrent를 갖는다(구조적 구분).
  if ('mpcur' in source) {
    const instance = source
    return {
      // write-through: 라이브 creature.mpcur에 바인딩(S4 마나 소비가 실 MP 감소).
      get mpCurrent() {
        return instance.mpcur
      },
      set mpCurrent(value: number) {
        instance.mpcur = value
      },
      level: instance.level,
      realm: instance.realm,
      class: instance.class,
      intBonus: bonusOf(instance.intelligence),
      knows: (spellNo: number) => F_ISSET(instance.spells, spellNo),
    }
  }
  const state = source
  return {
    // write-through: 라이브 state.mpCurrent에 바인딩.
    get mpCurrent() {
      return state.mpCurrent
    },
    set mpCurrent(value: number) {
      state.mpCurrent = value
    },
    level: state.level,
    // #85: 플레이어 realm 누적경험치 실이식 — mprofic 숙련 환산 입력(더 이상 [0,0,0,0] 스텁 아님).
    realm: state.realm,
    class: state.class,
    intBonus: bonusOf(state.effectiveIntelligence),
    // #85: 플레이어 spell store(uint8[16]) 실판독 — S_ISSET 이식(더 이상 false 스텁 아님).
    knows: (spellNo: number) => isKnown(state.spells, spellNo),
  }
}
