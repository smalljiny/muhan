import type { Character } from '../schema/character.js'
import { resolveHpMax, resolveMpMax } from './maxResolvers.js'

/**
 * progression/prestige — 승급(prestige) 순수 전이. 무적(INVINCIBLE) / 초인(CARETAKER)
 * 두 전환을 character→character 순수 함수로 옮긴다. Story 6 train이 `classifyPrestige`로
 * 게이트한 뒤 대응 전이 함수를 디스패치 소비한다(D6).
 *
 * 원본 `command7.c:607-635`(train 명령 내 승급 분기)의 progression 소관 부분만 재현한다.
 * class·level·experience·vitals만 바꾼 새 Character를 반환하고 나머지 필드는 스프레드
 * 보존한다(immutability).
 *
 * ## 미소유 (다른 시스템 소관)
 * - **gold 차감**: 원본은 승급 시 goldneeded를 차감하지만, 비용 게이트·차감은 train 소관이다.
 *   prestige는 순수 class/level/experience/vitals 전이만 소유한다.
 * - **dice(ndice/sdice/pdice=4)**: 초인의 4d4+4 데미지는 combat 라이브 투영(#82
 *   PlayerCombatState) 소관이며 characterSchema에 dice 필드가 없다. progression은 class 전이만
 *   소유하고 dice는 미소유한다.
 * - **가족/소셜(edit_member PFAMIL)·broadcast(I/O)**: progression 무관, skip.
 *
 * ## vitals 정책 (D4 예외 — 풀회복)
 * 레벨업(levelUp.resync)은 현재치를 새 최대치로 클램프만 하지만(D4 발산), 승급은 D4의 명시적
 * 예외로 **풀회복**한다 — 새 캐릭터 형태(class·level 전이 후)의 `resolveHpMax`/`resolveMpMax`를
 * 현재치에 그대로 대입한다(clamp 아님).
 */

/** INVINCIBLE(무적) 클래스 인덱스(mtype.h 정본). */
const INVINCIBLE = 9

/** CARETAKER(초인) 클래스 인덱스(mtype.h 정본). */
const CARETAKER = 10

/** 무적 전환 트리거 레벨. */
const INVINCIBLE_LEVEL = 100

/** 초인 전환 트리거·고정 레벨. */
const CARETAKER_LEVEL = 127

/**
 * 승급 분기를 판정한다. train이 이 결과로 전이 함수를 디스패치한다(D6).
 *
 * - `level===100 && class<9` → 'invincible' (일반직 → 무적)
 * - `level>=127 && class===9` → 'caretaker' (무적 → 초인)
 * - 그 외 → 'none'
 *
 * 무적(class<9)과 초인(class===9)은 class 조건이 배타적이라 분기 순서는 결과에 무관하나,
 * 명확성을 위해 무적을 먼저 검사한다. L100 무적(class===9)은 두 조건 모두 불충족 → 'none'.
 */
export function classifyPrestige(char: Character): 'invincible' | 'caretaker' | 'none' {
  if (char.level === INVINCIBLE_LEVEL && char.class < INVINCIBLE) return 'invincible'
  if (char.level >= CARETAKER_LEVEL && char.class === INVINCIBLE) return 'caretaker'
  return 'none'
}

/**
 * 무적 전환 — class=9·level=1·experience=0으로 전이하고 vitals를 새 형태 폐형 최대치로 풀회복한다.
 * 새 캐릭터는 class=9·level=1이라 초인 오버라이드(800/600) 대상이 아니라 폐형값을 따른다.
 *
 * **Precondition: `classifyPrestige(char)==='invincible'`.** train이 게이트 후 호출한다
 * (downLevel의 소비자-책임 관례). 방어적 조건 재확인은 하지 않는다.
 */
export function invinciblePrestige(char: Character): Character {
  const promoted = { ...char, class: INVINCIBLE, level: 1, experience: 0 }
  return {
    ...promoted,
    hpCurrent: resolveHpMax(promoted),
    mpCurrent: resolveMpMax(promoted),
  }
}

/**
 * 초인 전환 — class=10·level=127로 전이하고 vitals를 초인 오버라이드 최대치(800/600)로
 * 풀회복한다. experience는 원본이 초인 분기에서 건드리지 않으므로 유지한다(변경 없음).
 *
 * **Precondition: `classifyPrestige(char)==='caretaker'`.** train이 게이트 후 호출한다.
 */
export function caretakerPrestige(char: Character): Character {
  const promoted = { ...char, class: CARETAKER, level: CARETAKER_LEVEL }
  return {
    ...promoted,
    hpCurrent: resolveHpMax(promoted),
    mpCurrent: resolveMpMax(promoted),
  }
}
