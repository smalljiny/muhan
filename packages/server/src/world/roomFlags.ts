/**
 * roomFlags — 방 상태 플래그 비트 상수의 정본(mtype.h). room.flags는 8바이트(64비트) number[]라
 * `hasFlag`(door.ts)로 판독한다(hex-string F_ISSET 전용 hexFlags.ts와 구분).
 *
 * realm 4종(REARTH~RWATER)과 플레이어 위험방 4종(RPHARM~RPBEFU)을 여기서 단일 정의한다.
 * magic/offensiveSpell.ts(방 상성)와 combat/dot.ts(위험방 DoT)가 이 모듈을 import해 중복을 없앤다.
 * moveGates.ts의 RNOKIL(11)·RSUVIV(36)·RONEPL(14)·RTWOPL(15)·RTHREE(16)와 비트 충돌 없음.
 */

/** 땅 realm 방 — REARTH bit 19(mtype.h). EARTH 강화·WIND 약화(상성). */
export const REARTH = 19
/** 바람 realm 방 — RWINDR bit 20(mtype.h). WIND 강화·EARTH 약화. */
export const RWINDR = 20
/** 불 realm 방 — RFIRER bit 21(mtype.h). FIRE 강화·WATER 약화. */
export const RFIRER = 21
/** 물 realm 방 — RWATER bit 22(mtype.h). WATER 강화·FIRE 약화. */
export const RWATER = 22

/** 플레이어 가해 방 — RPHARM bit 24(mtype.h). 위험방 DoT 분기(player.c Branch C)의 유일한 진입 게이트. */
export const RPHARM = 24
/** 플레이어 독 방 — RPPOIS bit 25(mtype.h). 방문 틱마다 독을 부여하는 독 source(player.c F_SET PPOISN). */
export const RPPOIS = 25
/** 플레이어 mp 드레인 방 — RPMPDR bit 26(mtype.h). 틱마다 mp를 MIN(mpCurrent,3) 감소시킨다. */
export const RPMPDR = 26
/** 플레이어 혼란 방 — RPBEFU bit 27(mtype.h). LT_ATTCK 쿨다운 부여(combat-state 소관, #99 유예). */
export const RPBEFU = 27

/**
 * 주문 지속 강화 방 — RPMEXT bit 32(mtype.h:333 "Player magic spell extend"). 버프 시전 시 방 플래그가
 * 세팅돼 있으면 dur에 RPMEXT 보너스(표준 +800, detect/fly +600)를 가산한다(magic5-8.c
 * `F_ISSET(ply_ptr->parent_rom, RPMEXT)`). computeBuffDur input.rpmext의 방 판정 소스(#85 G5).
 */
export const RPMEXT = 32
