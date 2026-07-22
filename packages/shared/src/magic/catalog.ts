/**
 * 주문 카탈로그 선언 테이블 — spllist 56 + ospell 20의 read-only 메타데이터 단일 출처.
 *
 * ## 오라클 출처 (byte-level 정본)
 * - spllist: `legacy/muhan/src/global.c:575-631` (splstr 한글명·splno·spllv·splfn).
 * - spell 번호: `legacy/muhan/src/mtype.h:233-289` (SVIGOR=0 … SCHARM=55, SCURSE=56).
 * - ospell 격자: `legacy/muhan/src/global.c:637-659` (struct osp_t 20행).
 *
 * ## 엔트리 개수: 55가 아니라 56
 * spllist의 활성 행은 spellNo 0-55 = **56개**다(SCURSE=56은 spllist 미등록, SNAHAN은 주석).
 * 상위 태스크 문구의 "55"는 최대 인덱스(SCHARM=55)를 개수로 오독한 off-by-one이므로,
 * 포팅 원칙(byte 정본 우선)에 따라 56을 정본으로 삼는다.
 *
 * ## #85 유예 경계 — entries-not-bodies
 * 비-offensive 36 주문은 **메타데이터(엔트리)만** 둔다. C의 splfn(effect 함수 포인터)은
 * 옮기지 않는다(effect 본체는 #85 후속 Story). 엔트리에 함수 참조가 새어들지 않게 필드를
 * 5개(spellNo·koreanName·family·spllv·offensive)로 봉인한다.
 *
 * ## read-only
 * 이 모듈은 realm 성장·학습(study/teach) write 로직을 갖지 않는다 — 순수 선언 테이블 +
 * 조회 함수만 노출한다. 학습·성장 write는 후속 Story의 책임이다(완료 기준 5).
 */

/** 마법 realm — mtype.h:142-145. 값은 C osp_t.realm 바이트와 일치한다. */
export const REALM = {
  EARTH: 1,
  WIND: 2,
  FIRE: 3,
  WATER: 4,
} as const

export type Realm = (typeof REALM)[keyof typeof REALM]

/**
 * 주문 계열(family) — spllist splfn(effect 함수)을 도메인 카테고리로 추상화한 것이다.
 * offensive는 ospell 격자(공격 20종)에 대응하고, 나머지는 비-offensive 효과 유형을 묶는다.
 * antiUndead는 A6 스펙이 언급한 계열이나 spllist에 현재 멤버가 없다(union에만 보존).
 */
export type SpellFamily =
  | 'healing'
  | 'cure'
  | 'buff'
  | 'resistBuff'
  | 'detect'
  | 'movement'
  | 'debuff'
  | 'antiUndead'
  | 'utility'
  | 'offensive'

/**
 * spllist 카탈로그 엔트리 — effect 본체 없이 메타데이터만 담는다(#85 유예).
 * 필드는 정확히 5개로 고정한다(함수 참조 유입 차단).
 */
export interface SpellEntry {
  readonly spellNo: number
  readonly koreanName: string
  readonly family: SpellFamily
  readonly spllv: number
  readonly offensive: boolean
}

/** ospell 공격주문 엔트리 — C struct osp_t(global.c:637-659)의 필드 이름을 그대로 옮긴다. */
export interface OspellEntry {
  readonly spellNo: number
  readonly realm: Realm
  readonly mp: number
  readonly ndice: number
  readonly sdice: number
  readonly pdice: number
  readonly bonusType: number
}

/**
 * 주문 번호 상수 — mtype.h:233-289 #define 전사. spellNo 0-55.
 * 격자·카탈로그가 magic number 대신 이름으로 주문을 참조하게 한다.
 */
export const SPELL_NO = {
  SVIGOR: 0,
  SHURTS: 1,
  SLIGHT: 2,
  SCUREP: 3,
  SBLESS: 4,
  SPROTE: 5,
  SFIREB: 6,
  SINVIS: 7,
  SRESTO: 8,
  SDINVI: 9,
  SDMAGI: 10,
  STELEP: 11,
  SBEFUD: 12,
  SLGHTN: 13,
  SICEBL: 14,
  SENCHA: 15,
  SRECAL: 16,
  SSUMMO: 17,
  SMENDW: 18,
  SFHEAL: 19,
  STRACK: 20,
  SLEVIT: 21,
  SRFIRE: 22,
  SFLYSP: 23,
  SRMAGI: 24,
  SSHOCK: 25,
  SRUMBL: 26,
  SBURNS: 27,
  SBLIST: 28,
  SDUSTG: 29,
  SWBOLT: 30,
  SCRUSH: 31,
  SENGUL: 32,
  SBURST: 33,
  SSTEAM: 34,
  SSHATT: 35,
  SIMMOL: 36,
  SBLOOD: 37,
  STHUND: 38,
  SEQUAK: 39,
  SFLFIL: 40,
  SKNOWA: 41,
  SREMOV: 42,
  SRCOLD: 43,
  SBRWAT: 44,
  SSSHLD: 45,
  SLOCAT: 46,
  SDREXP: 47,
  SRMDIS: 48,
  SRMBLD: 49,
  SFEARS: 50,
  SRVIGO: 51,
  STRANO: 52,
  SBLIND: 53,
  SSILNC: 54,
  SCHARM: 55,
} as const

/**
 * spllist 56주문 선언 테이블 — global.c:575-631 순서대로 전사한다.
 *
 * family는 splfn(C effect 함수)을 도메인 카테고리로 매핑한 것이다: 예) vigor·mend·heal·
 * restore·room_vigor→healing, curepoison·rm_disease·rm_blind·remove_curse→cure,
 * resist_fire·resist_cold·resist_magic·earth_shield→resistBuff, detectinvis·detectmagic·
 * track·know_alignment·locate→detect, teleport·recall·summon·fly→movement,
 * befuddle·fear·blind·silence·charm·drain_exp→debuff.
 * offensive 20종(splfn=offensive_spell)은 family=offensive·offensive=true로 격자(OSPELL_GRID)에 대응한다.
 */
export const SPELL_CATALOG: readonly SpellEntry[] = [
  { spellNo: SPELL_NO.SVIGOR, koreanName: '회복', family: 'healing', spllv: 1, offensive: false },
  { spellNo: SPELL_NO.SHURTS, koreanName: '삭풍', family: 'offensive', spllv: 2, offensive: true },
  { spellNo: SPELL_NO.SLIGHT, koreanName: '발광', family: 'utility', spllv: 2, offensive: false },
  { spellNo: SPELL_NO.SCUREP, koreanName: '해독', family: 'cure', spllv: 1, offensive: false },
  { spellNo: SPELL_NO.SBLESS, koreanName: '성현진', family: 'buff', spllv: 2, offensive: false },
  { spellNo: SPELL_NO.SPROTE, koreanName: '수호진', family: 'buff', spllv: 2, offensive: false },
  { spellNo: SPELL_NO.SFIREB, koreanName: '화궁', family: 'offensive', spllv: 3, offensive: true },
  { spellNo: SPELL_NO.SINVIS, koreanName: '은둔법', family: 'buff', spllv: 5, offensive: false },
  { spellNo: SPELL_NO.SRESTO, koreanName: '도력반', family: 'healing', spllv: 4, offensive: false },
  { spellNo: SPELL_NO.SDINVI, koreanName: '은둔감지술', family: 'detect', spllv: 3, offensive: false },
  { spellNo: SPELL_NO.SDMAGI, koreanName: '주문감지술', family: 'detect', spllv: 3, offensive: false },
  { spellNo: SPELL_NO.STELEP, koreanName: '축지법', family: 'movement', spllv: 4, offensive: false },
  { spellNo: SPELL_NO.SBEFUD, koreanName: '혼동', family: 'debuff', spllv: 3, offensive: false },
  { spellNo: SPELL_NO.SLGHTN, koreanName: '뇌전', family: 'offensive', spllv: 4, offensive: true },
  { spellNo: SPELL_NO.SICEBL, koreanName: '동설주', family: 'offensive', spllv: 5, offensive: true },
  { spellNo: SPELL_NO.SENCHA, koreanName: '빙의', family: 'utility', spllv: 4, offensive: false },
  { spellNo: SPELL_NO.SRECAL, koreanName: '귀환', family: 'movement', spllv: 3, offensive: false },
  { spellNo: SPELL_NO.SSUMMO, koreanName: '소환', family: 'movement', spllv: 3, offensive: false },
  { spellNo: SPELL_NO.SMENDW, koreanName: '원기회복', family: 'healing', spllv: 3, offensive: false },
  { spellNo: SPELL_NO.SFHEAL, koreanName: '완치', family: 'healing', spllv: 5, offensive: false },
  { spellNo: SPELL_NO.STRACK, koreanName: '추적', family: 'detect', spllv: 4, offensive: false },
  { spellNo: SPELL_NO.SLEVIT, koreanName: '부양술', family: 'buff', spllv: 3, offensive: false },
  { spellNo: SPELL_NO.SRFIRE, koreanName: '방열진', family: 'resistBuff', spllv: 3, offensive: false },
  { spellNo: SPELL_NO.SFLYSP, koreanName: '비상술', family: 'movement', spllv: 4, offensive: false },
  { spellNo: SPELL_NO.SRMAGI, koreanName: '보마진', family: 'resistBuff', spllv: 3, offensive: false },
  { spellNo: SPELL_NO.SSHOCK, koreanName: '권풍술', family: 'offensive', spllv: 5, offensive: true },
  { spellNo: SPELL_NO.SRUMBL, koreanName: '지동술', family: 'offensive', spllv: 2, offensive: true },
  { spellNo: SPELL_NO.SBURNS, koreanName: '화선도', family: 'offensive', spllv: 2, offensive: true },
  { spellNo: SPELL_NO.SBLIST, koreanName: '탄수공', family: 'offensive', spllv: 2, offensive: true },
  { spellNo: SPELL_NO.SDUSTG, koreanName: '풍마현', family: 'offensive', spllv: 3, offensive: true },
  { spellNo: SPELL_NO.SWBOLT, koreanName: '파초식', family: 'offensive', spllv: 3, offensive: true },
  { spellNo: SPELL_NO.SCRUSH, koreanName: '폭진', family: 'offensive', spllv: 3, offensive: true },
  { spellNo: SPELL_NO.SENGUL, koreanName: '낙석', family: 'offensive', spllv: 5, offensive: true },
  { spellNo: SPELL_NO.SBURST, koreanName: '화풍술', family: 'offensive', spllv: 3, offensive: true },
  { spellNo: SPELL_NO.SSTEAM, koreanName: '화룡대천', family: 'offensive', spllv: 3, offensive: true },
  { spellNo: SPELL_NO.SSHATT, koreanName: '토합술', family: 'offensive', spllv: 4, offensive: true },
  { spellNo: SPELL_NO.SIMMOL, koreanName: '주작현', family: 'offensive', spllv: 4, offensive: true },
  { spellNo: SPELL_NO.SBLOOD, koreanName: '열사천', family: 'offensive', spllv: 4, offensive: true },
  { spellNo: SPELL_NO.STHUND, koreanName: '파천풍', family: 'offensive', spllv: 5, offensive: true },
  { spellNo: SPELL_NO.SEQUAK, koreanName: '지옥패', family: 'offensive', spllv: 5, offensive: true },
  { spellNo: SPELL_NO.SFLFIL, koreanName: '태양안', family: 'offensive', spllv: 5, offensive: true },
  { spellNo: SPELL_NO.SKNOWA, koreanName: '선악감지', family: 'detect', spllv: 3, offensive: false },
  { spellNo: SPELL_NO.SREMOV, koreanName: '저주해소', family: 'cure', spllv: 4, offensive: false },
  { spellNo: SPELL_NO.SRCOLD, koreanName: '방한진', family: 'resistBuff', spllv: 3, offensive: false },
  { spellNo: SPELL_NO.SBRWAT, koreanName: '수생술', family: 'buff', spllv: 3, offensive: false },
  { spellNo: SPELL_NO.SSSHLD, koreanName: '지방호', family: 'resistBuff', spllv: 3, offensive: false },
  { spellNo: SPELL_NO.SLOCAT, koreanName: '천리안', family: 'detect', spllv: 4, offensive: false },
  { spellNo: SPELL_NO.SDREXP, koreanName: '백치술', family: 'debuff', spllv: 5, offensive: false },
  { spellNo: SPELL_NO.SRMDIS, koreanName: '치료', family: 'cure', spllv: 3, offensive: false },
  { spellNo: SPELL_NO.SRMBLD, koreanName: '개안술', family: 'cure', spllv: 3, offensive: false },
  { spellNo: SPELL_NO.SFEARS, koreanName: '공포', family: 'debuff', spllv: 4, offensive: false },
  { spellNo: SPELL_NO.SRVIGO, koreanName: '전회복', family: 'healing', spllv: 4, offensive: false },
  { spellNo: SPELL_NO.STRANO, koreanName: '전송', family: 'utility', spllv: 4, offensive: false },
  { spellNo: SPELL_NO.SBLIND, koreanName: '실명', family: 'debuff', spllv: 5, offensive: false },
  { spellNo: SPELL_NO.SSILNC, koreanName: '봉합구', family: 'debuff', spllv: 5, offensive: false },
  { spellNo: SPELL_NO.SCHARM, koreanName: '이혼대법', family: 'debuff', spllv: 5, offensive: false },
] as const

type Tier = 1 | 2 | 3 | 4 | 5

/** tier별 격자 기본 파라미터 — global.c ospell 5개 tier 그룹의 공통 값을 압축한다. */
interface TierBase {
  readonly mp: number
  readonly ndice: number
  readonly sdice: number
  readonly pdice: number
  readonly bonusType: number
}

// tier 기본 셀 — 각 tier 4행(WIND·EARTH·FIRE·WATER) 중 다수 값. 소수 예외는 OSPELL_EXCEPTIONS.
const TIER_BASE: Record<Tier, TierBase> = {
  1: { mp: 3, ndice: 1, sdice: 8, pdice: 0, bonusType: 1 },
  2: { mp: 7, ndice: 2, sdice: 5, pdice: 7, bonusType: 2 },
  3: { mp: 10, ndice: 2, sdice: 5, pdice: 13, bonusType: 2 },
  4: { mp: 15, ndice: 3, sdice: 4, pdice: 18, bonusType: 3 },
  5: { mp: 25, ndice: 4, sdice: 5, pdice: 30, bonusType: 3 },
}

// (tier, realm) → spellNo. global.c ospell 행의 splno를 격자 좌표로 재배열한 것이다.
const GRID_SPELL_NO: Record<Tier, Record<Realm, number>> = {
  1: {
    [REALM.WIND]: SPELL_NO.SHURTS,
    [REALM.EARTH]: SPELL_NO.SRUMBL,
    [REALM.FIRE]: SPELL_NO.SBURNS,
    [REALM.WATER]: SPELL_NO.SBLIST,
  },
  2: {
    [REALM.WIND]: SPELL_NO.SDUSTG,
    [REALM.EARTH]: SPELL_NO.SCRUSH,
    [REALM.FIRE]: SPELL_NO.SFIREB,
    [REALM.WATER]: SPELL_NO.SWBOLT,
  },
  3: {
    [REALM.WIND]: SPELL_NO.SSHOCK,
    [REALM.EARTH]: SPELL_NO.SENGUL,
    [REALM.FIRE]: SPELL_NO.SBURST,
    [REALM.WATER]: SPELL_NO.SSTEAM,
  },
  4: {
    [REALM.WIND]: SPELL_NO.SLGHTN,
    [REALM.EARTH]: SPELL_NO.SSHATT,
    [REALM.FIRE]: SPELL_NO.SIMMOL,
    [REALM.WATER]: SPELL_NO.SBLOOD,
  },
  5: {
    [REALM.WIND]: SPELL_NO.STHUND,
    [REALM.EARTH]: SPELL_NO.SEQUAK,
    [REALM.FIRE]: SPELL_NO.SFLFIL,
    [REALM.WATER]: SPELL_NO.SICEBL,
  },
}

/** 격자 기본값에서 벗어나는 셀만 sdice/pdice 오버라이드로 명시한다(global.c 관찰 근거 주석 참조). */
interface OspellException {
  readonly realm: Realm
  readonly tier: Tier
  readonly override: Partial<Pick<OspellEntry, 'sdice' | 'pdice'>>
}

const OSPELL_EXCEPTIONS: readonly OspellException[] = [
  // FIRE tier1(화선도 SBURNS): sdice 8→7, pdice 0→1 — global.c:640.
  { realm: REALM.FIRE, tier: 1, override: { sdice: 7, pdice: 1 } },
  // FIRE tier2(화궁 SFIREB): pdice 7→8 — global.c:645.
  { realm: REALM.FIRE, tier: 2, override: { pdice: 8 } },
  // WATER tier2(파초식 SWBOLT): pdice 7→8 — global.c:646.
  { realm: REALM.WATER, tier: 2, override: { pdice: 8 } },
  // EARTH tier4(토합술 SSHATT): pdice 18→19 — global.c:654.
  { realm: REALM.EARTH, tier: 4, override: { pdice: 19 } },
]

const TIERS: readonly Tier[] = [1, 2, 3, 4, 5]
const REALMS: readonly Realm[] = [REALM.EARTH, REALM.WIND, REALM.FIRE, REALM.WATER]

/** 예외 셀 조회 — (realm, tier)에 해당하는 오버라이드가 있으면 반환한다. */
function exceptionFor(realm: Realm, tier: Tier): OspellException['override'] {
  const hit = OSPELL_EXCEPTIONS.find((e) => e.realm === realm && e.tier === tier)
  return hit ? hit.override : {}
}

/** realm×tier 격자를 기본 파라미터 + 예외 오버라이드로 전개해 ospell 20 엔트리를 생성한다. */
function buildGrid(): readonly OspellEntry[] {
  const entries: OspellEntry[] = []
  for (const tier of TIERS) {
    const base = TIER_BASE[tier]
    for (const realm of REALMS) {
      const override = exceptionFor(realm, tier)
      entries.push({
        spellNo: GRID_SPELL_NO[tier][realm],
        realm,
        mp: base.mp,
        ndice: base.ndice,
        sdice: override.sdice ?? base.sdice,
        pdice: override.pdice ?? base.pdice,
        bonusType: base.bonusType,
      })
    }
  }
  return entries
}

/** ospell 공격주문 격자 — realm 1-4 × tier 1-5 = 20 엔트리. */
export const OSPELL_GRID: readonly OspellEntry[] = buildGrid()

// spellNo → 카탈로그/격자 엔트리 조회 맵. 반복 find를 피하고 조회를 O(1)로 만든다(cast는
// per-round hot path). 두 조회 함수가 동일 인덱스 전략을 공유한다(56·20 정적 테이블, 모듈 로드 1회 빌드).
const SPELL_BY_NO: ReadonlyMap<number, SpellEntry> = new Map(
  SPELL_CATALOG.map((entry) => [entry.spellNo, entry]),
)
const OSPELL_BY_NO: ReadonlyMap<number, OspellEntry> = new Map(
  OSPELL_GRID.map((entry) => [entry.spellNo, entry]),
)

/** spellNo로 카탈로그 엔트리를 조회한다. 범위 밖이면 undefined. */
export function spellByNo(spellNo: number): SpellEntry | undefined {
  return SPELL_BY_NO.get(spellNo)
}

/** spellNo로 ospell 격자 엔트리를 조회한다. 공격주문이 아니면 undefined. */
export function ospellOf(spellNo: number): OspellEntry | undefined {
  return OSPELL_BY_NO.get(spellNo)
}
