import { resolveHpMax, resolveMpMax, clampVital, bonusOf, StatIndex, type Character } from 'shared'
import { hasFlag } from '../world/door.js'
import type { WorldTickSlot } from '../world/worldClock.js'

/**
 * progression/regen — HP/MP 재생. WorldClock에 얹히는 `intervalSec:5` 슬롯 1개가 활성 플레이어의
 * hpCurrent/mpCurrent를 재생 공식으로 채운다.
 *
 * 원본 충실: player.c:588-604의 재생 본문을 이식한다. shared 순수 함수(resolveHpMax·resolveMpMax·
 * clampVital·bonusOf)를 소비하고, room flag는 hasFlag(F_ISSET 이식)로 판독한다. 재생 산술은
 * regenVitals가 순수 함수로 소유하고, 슬롯은 케이던스·플레이어 순회·영속화(markDirty) seam만 소유한다.
 *
 * ## 오라클 outer guard 미구현 (전체 생략, 의도된 결정)
 * 원본 재생 블록은 `if(!RPHARM && !ill && !PPOISN)`로 감싸여 있다(방 RPHARM 플래그·질병 상태·독
 * 상태면 재생 스킵). 본 이식은 이 outer guard를 **통째로** 생략한다 — deps가 room.flags와 poison/
 * ill 필드 없는 Character만 넘기므로 guard를 완전히 구현할 입력이 없다. RPHARM만(room.flags로 도달
 * 가능) 부분 구현하고 ill/PPOISN을 빠뜨리는 비대칭 partial guard는 조용한 정합성 갭이라 회피하고,
 * 상태 필드가 스키마에 붙는 후속 토픽에서 세 조건을 함께 이식한다.
 *
 * ## RHEALR /=3 케이던스 가속 미구현 (D5)
 * 원본은 RHEALR(회복실) 방에서 `lasttime[LT_HEALS].interval /= 3`으로 재생 케이던스를 가속한다.
 * 본 이식은 이 /3 가속을 구현하지 않는다 — WorldClock 슬롯의 intervalSec는 정수·전 플레이어 공유
 * 상수라 방별 케이던스 분기를 얹을 수 없다(단일 슬롯 제약). RHEALR의 +100 진폭만 재현하고 케이던스는
 * 고정 5초로 둔다. 방별 재생 주기 차등은 per-player 스케줄러를 도입하는 후속 토픽에서 다룬다.
 *
 * ## immutability
 * regenVitals는 순수 함수로 입력 char를 변형하지 않고 새 Character를 반환한다. 슬롯 run은 tick 계층
 * carve-out으로 라이브 char를 in-place 갱신하되(creatureTick 선례 — 다음 발화가 누적 baseline을
 * 잇게 함), markDirty에는 distinct 스냅샷을 넘긴다(dirtyTracker 계약).
 */

/** RHEALR(회복실) 방 플래그 비트(mtype.h). +100 재생 진폭 트리거. */
export const RHEALR = 13

/** BARBARIAN(권법가) class 인덱스(mtype.h:92-105). HP 재생에 +2 보너스. */
export const BARBARIAN = 2

/** MAGE(도술사) class 인덱스(mtype.h:92-105). MP 재생에 +2 보너스. */
export const MAGE = 5

/** RHEALR 방의 HP/MP 재생 가산 진폭(player.c:592-593). */
const HEALER_ROOM_BONUS = 100

/** 재생 최소 바닥(player.c:589-590 MAX(4,…)). */
const REGEN_FLOOR = 4

/** 재생 슬롯 케이던스(실초). 원본 lasttime[LT_HEALS].interval=5 미러. */
const REGEN_INTERVAL_SEC = 5

/** 영속화 대상 컬렉션명. */
const CHARACTERS_COLLECTION = 'characters'

/**
 * 한 플레이어의 HP/MP를 재생 공식으로 올려 새 Character를 반환한다(순수 — 입력 무변이).
 *
 * player.c:589-599 이식. 정상 재생 → RHEALR 방이면 +100 → 최종 클램프 순서로 적용한다(클램프는
 * RHEALR 가산 뒤 1회만). hpGain/mpGain은 각각 MAX(4,…) 바닥을 가진다.
 */
export function regenVitals(char: Character, room: { flags: number[] }): Character {
  // con=stats[2], int=stats[3] — 정본 StatIndex enum(shared/stats/tables.ts)으로 인덱싱.
  const con = char.stats[StatIndex.constitution]
  const int = char.stats[StatIndex.intelligence]

  // player.c:589 hpcur += MAX(4, 5 + bonus[con] + (class==BARBARIAN ? 2:0))
  const hpGain = Math.max(REGEN_FLOOR, 5 + bonusOf(con) + (char.class === BARBARIAN ? 2 : 0))
  // player.c:590 mpcur += MAX(4, 5 + (int>17 ? 1:0) + (class==MAGE ? 2:0))
  const mpGain = Math.max(REGEN_FLOOR, 5 + (int > 17 ? 1 : 0) + (char.class === MAGE ? 2 : 0))

  let hp = char.hpCurrent + hpGain
  let mp = char.mpCurrent + mpGain

  // player.c:592-596 RHEALR 방: +100 진폭(/=3 케이던스 가속은 미구현 — 상단 D5 주석).
  if (hasFlag(room.flags, RHEALR)) {
    hp += HEALER_ROOM_BONUS
    mp += HEALER_ROOM_BONUS
  }

  // player.c:597-598 최종 클램프(정상재생·RHEALR 가산을 모두 반영한 뒤 1회).
  return {
    ...char,
    hpCurrent: clampVital(hp, resolveHpMax(char)),
    mpCurrent: clampVital(mp, resolveMpMax(char)),
  }
}

/** 재생 슬롯이 소비하는 seam. players 미주입 시 dormant(빈 iterable → no-op). */
export type RegenDeps = {
  /** 활성 플레이어·소재 방 조회 seam. 기본값은 빈 iterable(dormant). */
  players?: () => Iterable<{ character: Character; room: { flags: number[] } }>
  /** 재생 변이 스냅샷 영속화 seam. */
  markDirty: (collection: string, id: string, snapshot: unknown) => void
}

/**
 * 재생 WorldClock 슬롯을 생성한다(intervalSec=5, name='regen'). deps는 클로저에 캡슐화한다
 * (gameTime 슬롯 팩토리 관례). run은 활성 플레이어마다 regenVitals로 재생값을 계산하고, 라이브
 * char를 carve-out으로 in-place 갱신한 뒤 distinct 스냅샷을 markDirty로 흘린다.
 */
export function createRegenSlot(deps: RegenDeps): WorldTickSlot {
  const players = deps.players ?? ((): Iterable<never> => [])

  return {
    name: 'regen',
    intervalSec: REGEN_INTERVAL_SEC,
    run(): void {
      for (const entry of players()) {
        const regenerated = regenVitals(entry.character, entry.room)
        // carve-out: 라이브 char에 재생값을 반영해 다음 발화가 누적 baseline을 잇는다.
        entry.character.hpCurrent = regenerated.hpCurrent
        entry.character.mpCurrent = regenerated.mpCurrent
        // regenerated는 regenVitals가 갓 만든 distinct 객체(라이브 char와 별개)라 그대로 스냅샷으로
        // 넘긴다 — 이후 라이브 char 변이가 전파되지 않는다(dirtyTracker 계약).
        deps.markDirty(CHARACTERS_COLLECTION, entry.character._id, regenerated)
      }
    },
  }
}
