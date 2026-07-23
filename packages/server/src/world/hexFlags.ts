/**
 * hex string 비트 헬퍼 — 크리처/오브젝트 flags(8바이트 = 16자 hex string)의 비트 조회·세팅·클리어.
 *
 * 원본 `F_ISSET(p,f) = flags[f/8] & (1<<(f%8))`(mtype.h) 이식. door.ts `hasFlag`는 바이트당 한
 * 원소인 number[]용이라 여기 hex string 표현(creatures.json·objects.json·rooms.json의 flags 필드)에는
 * 부적합하다. 이 모듈은 hex string을 그대로 다뤄 별도 디코딩 없이 비트를 판정한다.
 *
 * F_SET/F_CLR은 in-place 변형 대신 새 문자열을 반환한다 — autonomic(순수 함수)이 새 크리처 상태를
 * 만들 때 flags를 교체하는 용도다(입력 flags 불변).
 */

// ── 크리처 M-flag 비트(mtype.h 검증) ─────────────────────────────────────────
/** 고정 몬스터(입장 리스폰 대상). */
export const MPERMT = 0
/** 무차별 공격형. */
export const MAGGRE = 6
/** 투명 탐지(Detect invisibility) — MDINVI(mtype.h:432). aggro 타깃선정 시 PINVIS 플레이어 자격 부여(update.c:589~592). */
export const MDINVI = 21
/** 독 특수공격 — MPOISS(mtype.h). 근접 후 독 부여 게이트 rng(1,100)<=15(update.c:387~480). */
export const MPOISS = 13
/** 브레스 특수공격 보유 — MBRETH(mtype.h). 브레스 발동 게이트 rng(1,30)<5(update.c:387~480). */
export const MBRETH = 19
/** 브레스 타입 비트1 — MBRWP1(mtype.h). MBRWP2와 2비트 조합으로 브레스 4타입 분기(update.c:387~480). */
export const MBRWP1 = 28
/** 브레스 타입 비트2 — MBRWP2(mtype.h). MBRWP1과 2비트 조합으로 브레스 4타입 분기(update.c:387~480). */
export const MBRWP2 = 29
/** 에너지드레인 특수공격 — MENEDR(mtype.h). 브레스 미발동 시에만 드레인 게이트 rng(1,100)<10(update.c:387~480). */
export const MENEDR = 30
/** 질병 특수공격 — MDISEA(mtype.h). 근접 후 질병 부여 게이트 rng(1,100)<=10(update.c:387~480). */
export const MDISEA = 34
/** 장비용해 특수공격 — MDISIT(mtype.h). 근접 후 게이트 rng(1,100)<=15(update.c:387~480, 효과는 유예). */
export const MDISIT = 35
/** 실명 특수공격 — MBLNDR(mtype.h). 근접 후 실명 부여 게이트 rng(1,100)<=10(update.c:387~480). */
export const MBLNDR = 45
/** scavenger(바닥 아이템 회수). */
export const MSCAVE = 11
/** 아이템 소지형 — MTRADE(mtype.h:448 "monster will give items"). 사망 시 인벤토리 드롭 억제 게이트(creature.c:311). */
export const MTRADE = 37
/** 주문 시전 가능 — MMAGIC(mtype.h:17 `#define MMAGIC 17`, "Can cast spells"). 몬스터 틱 주문 분기 게이트(update.c:348). */
export const MMAGIC = 17
/** 무언가 주움(scavenge 성공 표식 — wander-out 제외 조건). */
export const MHASSC = 18
/** 마법으로만 피해(무기 무효) — MMGONL(mtype.h:431). 전투 대상 무적 게이트(command5.c:161). */
export const MMGONL = 20
/** 마법/마법무기로만 피해 — MENONL(mtype.h:433). class<CARETAKER + 비마법무기면 거부(command5.c:167). */
export const MENONL = 22
/** 절대 해칠 수 없음 — MUNKIL(mtype.h:435). 전투 대상 무적 무조건 거부(command5.c:146). */
export const MUNKIL = 24
/** 마법 저항(크리처) — MRMAGI(mtype.h:438). offensive_spell 데미지 감산 게이트(magic1.c:1113). */
export const MRMAGI = 27
/** 혼동(befuddle) 저항 — MRBEFD(mtype.h:454 "Monster resists stun only"). 혼동술 dur=3 단축(magic3.c:775). */
export const MRBEFD = 43
/** 공포(fear) 상태 — MFEARS(mtype.h:458 "Monster is fearful"). fear 시전 시 F_SET(magic8.c:404). */
export const MFEARS = 47
/** 침묵(silence) 상태 — MSILNC(mtype.h:459 "Monster has been silenced"). silence 시전 시 F_SET(magic8.c:529). */
export const MSILNC = 48
/** 실명(blind) 상태 — MBLIND(mtype.h:460 "Monster is blind"). blind 시전 시 F_SET(magic8.c:276). */
export const MBLIND = 49
/** 매혹 불가 — MNOCHA(mtype.h:473 "Monster cannot be charmed"). charm 완전 반탄 조건(magic8.c:751). */
export const MNOCHA = 62
/** 선한 유저 공격형(정렬 alg=-1). */
export const MGAGGR = 39
/** 악한 유저 공격형(정렬 alg=1). */
export const MEAGGR = 40
/** DM 추종 몬스터(wander-out 제외 조건). */
export const MDMFOL = 46
/** 매혹(charm) 상태. */
export const MCHARM = 50
/** 혼동(befuddle) 상태. */
export const MBEFUD = 51
/** 사망 시 부하 소환(Story 5 onDeathSummon). */
export const MSUMMO = 61

// ── 플레이어 P-flag 비트(mtype.h #define 검증) ───────────────────────────────
// 원작 무한/Mordor는 플레이어도 creature 구조체라 P-flag는 creature flags와 동일 바이트 배열을
// 같은 F_ISSET(0-index `flags[f/8]&(1<<(f%8))`)로 읽는다 — M-flag와 다른 오프셋 체계일 수 없다.
// 비트 인덱스가 31을 넘으므로(42·43) 32비트 number bitfield로는 표현 불가 — hex string 표현이 정본.
// help/pflags 문서 값(PBLIND 43·PFEARS 44)은 raw #define보다 +1이므로 mtype.h를 정본으로 채택한다.
/** 숨음(hidden) 상태 — PHIDDN(mtype.h:346). aggro 타깃선정 자격 제외(player.c:1327 lowest_piety, 1490 low_piety_alg). */
export const PHIDDN = 1
/** 투명(invisibility) 상태 — PINVIS(mtype.h:347). aggro 타깃선정 시 공격자 MDINVI 없으면 자격 제외(player.c:1328). */
export const PINVIS = 2
/** DM 투명 — PDMINV(mtype.h:355). aggro 타깃선정 무조건 자격 제외(player.c:1329). */
export const PDMINV = 10
/** 소심(wimpy) 도주 모드 — PWIMPY(mtype.h:359). hpcur<=wimpyValue면 도주 결정(update.c:534~538). */
export const PWIMPY = 14
/** 중독(poison) 상태 — 주기 피해 상태이상(interval 틱마다 피해). PPOISN(mtype.h `#define PPOISN 16`). */
export const PPOISN = 16
/** 질병(disease) 상태 — 주기 피해 상태이상(interval 틱마다 피해). PDISEA(mtype.h `#define PDISEA 41`). */
export const PDISEA = 41
/** 실명(blind) 상태 — 명중 임계 +5(command5.c:234). PBLIND(mtype.h:387). */
export const PBLIND = 42
/** 공포(fear) 상태 — 명중 임계 +2(command5.c:233). PFEARS(mtype.h:388). */
export const PFEARS = 43
/** 침묵(silence) 상태 — 발화 불가. teach 전수 게이트가 읽음(magic1.c:145). PSILNC(mtype.h:389). */
export const PSILNC = 44
/** 혼돈(Chaotic/!Lawful) — PCHAOS(mtype.h:373). 선악 PvP 동의 게이트가 읽음(command5.c:184). */
export const PCHAOS = 28
/**
 * 화염 저항(방어자) — PRFIRE(mtype.h). 화염 브레스 데미지 반감 게이트 — 세팅 시 dice((lv+3)/4,2,0),
 * 미세팅 시 dice((lv+3)/4,4,0)(update.c:387~480).
 */
export const PRFIRE = 30
/**
 * 냉기 저항(방어자) — PRCOLD(mtype.h). 냉기 브레스 데미지 반감 게이트 — 세팅 시 dice((lv+3)/4,2,0),
 * 미세팅 시 dice((lv+3)/4,4,0)(update.c:387~480).
 */
export const PRCOLD = 36
/**
 * 대지 저항(방어자) — PSSHLD(mtype.h:383 `#define PSSHLD 38`). earth_shield(지방호) 시전 시 F_SET
 * (magic7.c:252·286). resistBuff family 4주문 중 SSSHLD 대응 저항 플래그(PRFIRE/PRMAGI/PRCOLD와 동렬,
 * #85 G5). #84 저항-read 미배선(플레이어 저항 감산 유예) — 상수·투영만 보존한다.
 */
export const PSSHLD = 38
/** 패거리 가입자 — PFAMIL(mtype.h:400). 양측 PFAMIL이면 선악 게이트를 check_war로 게이팅(command5.c:183). */
export const PFAMIL = 55

// ── 버프·감지 P-flag 비트(mtype.h #define, Story 9 G7 timed effect) ───────────
// 원작은 P-flag를 creature flags와 같은 바이트 배열에 F_SET한다(예 bless: F_SET(ply,PBLESS)). 이 포트의
// Character엔 flags 필드가 없어 타이머는 buffs `{until}`로 영속하고, 활성 버프를 projectBuffFlags가 fresh
// P-flag hex로 투영한다(resistBuff의 projectResistFlags 계약 승계). 비트값은 mtype.h를 정본으로 전사한다.
/** 축복(bless) — PBLESS(mtype.h:345 `#define PBLESS 0`). SBLESS 시전 시 F_SET(magic3.c). PINVIS 등과 같은 flags 배열, 플레이어 문맥 비트0. */
export const PBLESS = 0
/** 수호(protection) — PPROTE(mtype.h:353 `#define PPROTE 8`). SPROTE 시전 시 F_SET(magic2.c:373). */
export const PPROTE = 8
/** 발광(light) — PLIGHT(mtype.h:362 `#define PLIGHT 17`). SLIGHT 시전 시 F_SET(magic2.c:314). */
export const PLIGHT = 17
/** 주문 감지(detect magic) — PDMAGI(mtype.h:365 `#define PDMAGI 20`). SDMAGI 시전 시 F_SET(magic4.c). */
export const PDMAGI = 20
/** 은둔 감지(detect invisible) — PDINVI(mtype.h:366 `#define PDINVI 21`). SDINVI 시전 시 F_SET(magic4.c). */
export const PDINVI = 21
/** 부양(levitation) — PLEVIT(mtype.h:370 `#define PLEVIT 25`). SLEVIT 시전 시 F_SET(magic5.c:509). */
export const PLEVIT = 25
/** 비행(flying) — PFLYSP(mtype.h:376 `#define PFLYSP 31`). SFLYSP 시전 시 F_SET(magic5.c). */
export const PFLYSP = 31
/** 선악 감지(know alignment) — PKNOWA(mtype.h:378 `#define PKNOWA 33`). SKNOWA 시전 시 F_SET(magic6.c). */
export const PKNOWA = 33
/** 수생(breathe water) — PBRWAT(mtype.h:382 `#define PBRWAT 37`). SBRWAT 시전 시 F_SET(magic7.c). */
export const PBRWAT = 37
/** 잠력격발 — PUPDMG(mtype.h:404). 초인 다중공격 count 게이트(command5.c:208). */
export const PUPDMG = 59
/**
 * 마법 저항(플레이어) — PRMAGI(mtype.h:377). offensive_spell 데미지 감산 게이트(magic1.c:1113).
 * #84 미발동(플레이어 대상 저항은 piety store가 없어 #85 소관) — 상수만 보존한다.
 */
export const PRMAGI = 32

// ── object flag 비트(scavenge 제외 판정) ─────────────────────────────────────
/** 영구 아이템(회수 불가). */
export const OPERMT = 0
/** 숨겨진 아이템(회수 불가). */
export const OHIDDN = 1
/** 영구2(회수 불가). */
export const OPERM2 = 9
/** 집을 수 없음(회수 불가). */
export const ONOTAK = 17
/** 배경 소품(회수 불가). */
export const OSCENE = 18
/** 선인 전용 아이템 — OGOODO(mtype.h:488). study 정렬 게이트(alignment<-100이면 연마 실패, magic1.c:305). */
export const OGOODO = 12
/** 악인 전용 아이템 — OEVILO(mtype.h:489). study 정렬 게이트(alignment>100이면 연마 실패, magic1.c:305). */
export const OEVILO = 13
/** 저주받은 무기 — OCURSE(mtype.h:498). 불발 시 무기 낙하 제외 조건(command5.c:298). */
export const OCURSE = 22
/** 클래스 전용 — OCLSEL(mtype.h:507). study 클래스 게이트 기준 비트(OCLSEL+class로 직업 허용 판정, magic1.c:312). */
export const OCLSEL = 31
/** 항상 크리티컬 무기 — OALCRT(mtype.h:518). 크리 판정 자동 통과(command5.c:281). */
export const OALCRT = 42

/** hex string에서 지정 비트가 속한 바이트 값(0–255)을 읽는다. 범위 밖이면 0. */
function byteAt(hex: string, bit: number): number {
  const i = (bit >> 3) * 2
  const chunk = hex.substring(i, i + 2)
  if (chunk.length < 2) return 0
  const v = parseInt(chunk, 16)
  return Number.isNaN(v) ? 0 : v
}

/**
 * 지정 바이트 인덱스를 새 값으로 교체한 hex string을 반환한다(불변).
 *
 * 입력이 대상 바이트 오프셋보다 짧으면(예: 빈 문자열에 고비트 세팅) 대상 오프셋까지 '0'으로
 * 채운 뒤 교체한다 — zero-pad가 없으면 substring이 짧은 문자열 전체를 반환해 고바이트 비트를
 * 낮은 바이트에 잘못 기록한다(플레이어 flags '' + PFEARS=44 경로). 16자 full-width 입력에는
 * padEnd가 no-op이라 기존 크리처/오브젝트 flags 동작은 불변.
 */
function withByte(hex: string, byteIdx: number, value: number): string {
  const i = byteIdx * 2
  const hexByte = (value & 0xff).toString(16).padStart(2, '0')
  const padded = hex.padEnd(i, '0')
  return padded.slice(0, i) + hexByte + padded.slice(i + 2)
}

/** 원본 F_ISSET — 비트가 세팅됐는지. 짧은/빈 hex는 미세팅(false)으로 취급한다. */
export function F_ISSET(hex: string, bit: number): boolean {
  return ((byteAt(hex, bit) >> (bit & 7)) & 1) === 1
}

/** 원본 F_SET — 지정 비트를 세팅한 새 hex string을 반환한다(입력 불변). */
export function F_SET(hex: string, bit: number): string {
  const byte = byteAt(hex, bit) | (1 << (bit & 7))
  return withByte(hex, bit >> 3, byte)
}

/** 원본 F_CLR — 지정 비트를 클리어한 새 hex string을 반환한다(입력 불변). */
export function F_CLR(hex: string, bit: number): string {
  const byte = byteAt(hex, bit) & ~(1 << (bit & 7))
  return withByte(hex, bit >> 3, byte)
}
