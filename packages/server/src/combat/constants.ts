/**
 * 전투 튜닝 상수 — 스펙 §3.7 외부화 값. byte-fidelity 오라클(command5.c)에서 뽑은 원시 굴림 범위·증분을
 * 이름 있는 상수로 분리해 후속 Story(5/6/8)가 매직 넘버 없이 소비한다.
 */

/** 크리티컬 배수 하한 — 오라클 `n *= mrand(3,6)`의 하한(command5.c:288). */
export const CRIT_MULTIPLIER_MIN = 3
/** 크리티컬 배수 상한 — 오라클 `n *= mrand(3,6)`의 상한. */
export const CRIT_MULTIPLIER_MAX = 6

/** 플레이어 명중 굴림 상한 — 오라클 `mrand(1,30) >= n`(command5.c:236, "원래값 20" d20→d30 완화). */
export const HIT_ROLL_MAX_PLAYER = 30
/** 몬스터 명중 굴림 상한 — 오라클 `mrand(1,20) >= n`(update.c:383, 플레이어보다 좁음). */
export const HIT_ROLL_MAX_MONSTER = 20

/** PvP 공격 쿨다운 증분(초) — 오라클 `lasttime[LT_ATTCK].interval += 3`(command5.c:201). */
export const PVP_COOLDOWN_INCREMENT = 3
