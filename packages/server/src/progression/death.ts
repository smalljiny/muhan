import { neededExp, resolveHpMax, resolveMpMax, type Character } from 'shared'

/**
 * progression/death — PvE 사망 페널티 seam(applyPlayerDeath). HP<1 사망 판정(발화는 #82 전투
 * 소관)이 호출하는 순수 소비자를 **정의만** 한다 — E4-2에는 전투 코드가 없어 어떤 호출부도 이
 * 함수를 부르지 않는다(test-driven, creatureDeath.ts 선례). index.ts 배선 대상도 아니다.
 *
 * 오라클 creature.c:371-466 PLAYER 사망 분기(PvE·자살) 소관:
 *   1. exp 손실 — level<20: 5%(exp/20), level≥20: exp/15(10만 캡). 이후 max(0, exp).
 *   2. 부활·회복 — 몬스터 피살은 hp/mp 풀회복, 독/질병 해제, reviveRoom 이동.
 * class·level·race·stats·gold 등 정체성 필드는 불변이다.
 *
 * ## ★ 플랜 D7 의도된 발산 — down_level 미호출, 레벨 유지
 * 오라클은 사망 시 `down_level`을 호출해 레벨을 강등하지만(creature.c: `while(level>n) down_level`),
 * 본 이식은 A7 §11 근거로 **레벨을 유지**한다. `level` 필드는 절대 변경하지 않고, 깎인 exp가 현재
 * 레벨 임계 아래로 내려가면 하한 `expFloor(level)`로 되끌어올려 레벨 정합을 흉내낸다. 결과적으로
 * 레벨 강등(down_level)이 발생하지 않는다.
 *
 * ## immutability
 * 입력 char를 변형하지 않는다 — 새 Character(distinct 참조)를 반환한다(train.ts·levelUp.ts 선례).
 */

/** 사망 후 부활 방 기본값(D8). opts.reviveRoom 미지정 시 사용한다. */
const DEFAULT_REVIVE_ROOM = 1008

/** level≥20 사망 exp 손실 상한(creature.c:445 — 10만 캡). */
const HIGH_LEVEL_EXP_LOSS_CAP = 100_000

/** applyPlayerDeath 옵션 — reviveRoom을 주입 상수로 받는다(기본 1008). */
export interface PlayerDeathOptions {
  /** 부활 방 번호(자연키). 미지정 시 DEFAULT_REVIVE_ROOM(1008). 방 0은 유효하므로 ??로 존중한다. */
  readonly reviveRoom?: number
}

/**
 * 레벨대별 exp 손실을 적용한 값을 반환한다(레벨 유지 — level 인자는 손실 공식 분기에만 쓴다).
 *
 * - level<20: `exp - trunc(exp/20)` (5% 손실).
 * - level≥20: `exp - min(trunc(exp/15), 100000)` (exp/15, 10만 캡). 오라클
 *   `if(exp/15>100000) exp-=100000; else exp-=exp/15;`와 항등이다.
 * - 이후 `max(0, exp)`. Math.trunc는 C integer division 정합(입력 exp≥0이라 실질 음수는 없다).
 */
function applyExpLoss(experience: number, level: number): number {
  const loss =
    level < 20
      ? Math.trunc(experience / 20)
      : Math.min(Math.trunc(experience / 15), HIGH_LEVEL_EXP_LOSS_CAP)
  return Math.max(0, experience - loss)
}

/**
 * 레벨 유지용 exp 하한을 반환한다(플랜 D7). `expFloor(level) = level<=2 ? 0 : neededExp(level-2)`.
 *
 * neededExp(level-2) = 원본 needed_exp[level-3]. level≤2에서 level-2≤0이면 인덱스 OOB이므로
 * 하한을 0으로 가드한다(neededExp를 음수/0 인자로 호출하지 않는다).
 */
function expFloor(level: number): number {
  if (level <= 2) return 0
  return neededExp(level - 2)
}

/**
 * PvE 사망 페널티를 적용한 새 Character를 반환한다 — exp 손실·레벨 유지·하한 클램프·부활·풀회복.
 *
 * 입력 char는 변형하지 않는다(순수). 발화자 없는 seam 정의(creatureDeath.ts 선례) — 프로덕션
 * 호출부는 #82 전투 에픽이 배선한다. index.ts 배선 대상 아님.
 */
export function applyPlayerDeath(char: Character, opts?: PlayerDeathOptions): Character {
  const reviveRoom = opts?.reviveRoom ?? DEFAULT_REVIVE_ROOM

  // 1. exp 손실 → 하한 클램프(레벨 강등 대신 exp를 하한으로 고정, D7).
  const lossExp = applyExpLoss(char.experience, char.level)
  const experience = Math.max(lossExp, expFloor(char.level))

  // 2. 부활·회복 — 몬스터 피살은 hp/mp 풀회복(D4 예외). class/level 불변이라 최대치는 기존 값 기준.
  //    DoT(독/질병) 해제는 스키마에 상태 플래그 필드가 없어 no-op이다.
  //    #83 이관: DoT(PPOISN/PDISEA) 해제는 상태 플래그 필드 미정의라 이번 범위 밖.
  return {
    ...char,
    experience,
    currentRoom: reviveRoom,
    hpCurrent: resolveHpMax(char),
    mpCurrent: resolveMpMax(char),
  }
}
