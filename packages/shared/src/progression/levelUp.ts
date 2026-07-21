import type { Character } from '../schema/character.js'
import { level_cycle } from './tables.js'
import { resolveHpMax, resolveMpMax, clampVital } from './maxResolvers.js'

/**
 * progression/levelUp — 레벨업(`upLevel`)·강등(`downLevel`) 순수 변이.
 *
 * 원본 `player.c:770`(up_level)/`player.c:820`(down_level)의 progression 소관 부분을 D3·D4
 * 정책으로 재해석해 결정적 순수 함수로 옮긴다. level·stats·hpCurrent·mpCurrent만 바꾼 새
 * Character를 반환하고 나머지 필드는 스프레드 보존한다(immutability). stats는 새 튜플로 만든다.
 *
 * ## 성장 게이트와 슬롯 인덱스
 * - 능력치 성장은 **newLevel%4==0**일 때만 1개 대상 능력치를 +1(강등은 -1)한다.
 * - 대상 슬롯 index = **(newLevel-2)%10**, 대상 능력치 값 v = `level_cycle[class][index]`(1..5).
 * - stats 튜플 인덱스 = **v-1**(enum STR=1..PTY=5 → StatIndex strength=0..piety=4). v=0은 무변화.
 * - index는 항상 짝수(newLevel%4==0 ⇒ newLevel 짝수)라 level_cycle 홀수 슬롯은 판독되지 않는다.
 *
 * ## 최대치·현재치 정책 (D3 재동기화 / D4 발산)
 * - 최대치는 %4 게이트 없이 **매 레벨 폐형 재동기화**한다(resolveHpMax/resolveMpMax of 새 레벨).
 * - hpCurrent/mpCurrent는 **올리지 않는다** — 새 최대치로 `clampVital` 클램프만 한다. 원본은
 *   %4==0에서 풀회복(hpcur=hpmax)했지만 신규는 재생이 격차를 메우는 발산을 의도한다(D4).
 */

/** CARETAKER 등 dice·PUPDMG 분기는 progression 소관이 아니라 무시한다(combat/prestige X2). */

/**
 * 레벨업 — level+1, newLevel%4==0이면 level_cycle 슬롯 대상 능력치 +1, 최대치 재동기화,
 * hpCurrent/mpCurrent는 새 최대치로 클램프(미상승). 새 Character를 반환한다.
 */
export function upLevel(char: Character): Character {
  const newLevel = char.level + 1
  const stats = applyGrowth(char, newLevel, +1)
  return resync({ ...char, level: newLevel, stats })
}

/**
 * 강등 — level-1, char.level%4==0(강등 전 레벨)이면 슬롯 대상 능력치 -1, 최대치 재동기화,
 * hpCurrent/mpCurrent는 새(작은) 최대치로 클램프다운. `downLevel(upLevel(char))`은 원복이다.
 *
 * **Precondition: `char.level >= 2`.** 원본 down_level과 동일하게 level에 floor를 두지 않는다 —
 * level 1 입력은 level 0을 산출해 `characterSchema.level.min(1)`을 위반한다. 소비자가 level>=2를
 * 보장한다(clampVital의 음수 미방어와 동일한 소비자-책임 관례). 이 토픽에는 런타임 소비자가
 * 없고(D7 death는 down_level 미호출·레벨 유지, chg_class_main은 Non-goal) inverse-property
 * 페어링으로만 소비되며, upLevel이 항상 level>=2를 방출하므로 그 경로에선 위반이 없다.
 */
export function downLevel(char: Character): Character {
  const newLevel = char.level - 1
  const stats = applyGrowth(char, char.level, -1)
  return resync({ ...char, level: newLevel, stats })
}

/**
 * 성장 게이트를 판정해 stats 새 튜플을 반환한다. `gateLevel`이 성장 판정 레벨이다 —
 * upLevel은 newLevel, downLevel은 char.level(강등 전). 게이트를 통과하면 슬롯 대상 능력치
 * 한 칸에 `delta`(+1/-1)를 적용하고, 아니면 원본 stats를 복제만 한다.
 */
function applyGrowth(char: Character, gateLevel: number, delta: number): Character['stats'] {
  const next = [...char.stats] as [number, number, number, number, number]
  if (gateLevel % 4 !== 0) return next
  const slot = (gateLevel - 2) % 10
  const statValue = level_cycle[char.class]?.[slot] ?? 0
  if (statValue < 1) return next
  const statIndex = statValue - 1
  next[statIndex] = (next[statIndex] ?? 0) + delta
  return next
}

/**
 * 새 레벨 폐형으로 HP/MP 최대치를 재동기화하고, 기존 현재치를 새 최대치로 클램프한다(미상승).
 * char은 이미 level·stats가 갱신된 상태로 들어온다.
 */
function resync(char: Character): Character {
  const hpCurrent = clampVital(char.hpCurrent, resolveHpMax(char))
  const mpCurrent = clampVital(char.mpCurrent, resolveMpMax(char))
  return { ...char, hpCurrent, mpCurrent }
}
