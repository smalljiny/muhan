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

/**
 * 몬스터 MMAGIC 주문 시전 확률(%) — 오라클 `n=20`(update.c:348), `mrand(1,100)<=n`이면 시전.
 * MMAGIO proficiency 경로(`n=proficiency[0]`)는 #84 범위 밖이라 이식하지 않는다.
 */
export const MONSTER_SPELL_CAST_CHANCE = 20

/** 반격 쿨다운 기본 간격(초) — 오라클 `interval=1`(command5.c:131, 무기/맨손 공통, PHASTE 무효 버그). */
export const ATTACK_COOLDOWN_INTERVAL = 1

/** 반격 쿨다운 실명 간격(초) — 오라클 `PBLIND`면 `interval=6`(command5.c:135). */
export const ATTACK_COOLDOWN_BLIND = 6

// ── 클래스 인덱스 상수(tables.ts:97-98, global.c class_stats 순서) ─────────────
// 플레이어 피해 분기·PALADIN 정렬 보정이 소비한다(command5.c:244-278).
/** 바바리안 — 자기 주사위 + (level+3)/4 성장 분기(command5.c:244). */
export const BARBARIAN = 2
/** 성직자 — MAGE와 함께 숙련/오프핸드 항을 벗기는 피해 override(command5.c:254). */
export const CLERIC = 3
/** 마법사 — CLERIC과 함께 피해 override(command5.c:254). */
export const MAGE = 5
/** 성기사 — 정렬(alignment) 기반 피해 보정(command5.c:266). */
export const PALADIN = 6
/** 무적(invincible) — `class > INVINCIBLE`이면 바바리안과 동일 성장 분기(command5.c:244). */
export const INVINCIBLE = 9
/** 운영진(caretaker) — `class < CARETAKER`인 플레이어만 MENONL 대상 무적에 걸린다(command5.c:167, mtype.h:103). */
export const CARETAKER = 10
