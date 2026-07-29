import { z } from 'zod'
import { SPELL_CATALOG } from '../magic/catalog.js'

/**
 * buffs 엔트리 하나의 형태 — 주문번호별 만료 타이머. until은 statusEffects와 동일한 절대-틱
 * 만료 관례다(잔여-틱 아님). strictObject라 interval 등 미정의 키를 거부한다 — 버프는 주기 효과가
 * 아니므로 interval을 갖지 않는다(D2 — statusEffects DoT와 결합 표면 분리).
 */
const buffEntrySchema = z.strictObject({ until: z.int().min(0) })

/**
 * buffs 필드의 키 형태 — 카탈로그 주문번호(0-55)를 키로 하는 strictObject 셰이프를 SPELL_CATALOG에서
 * 파생한다. 수기 56키 열거 대신 카탈로그를 단일 출처로 삼아 드리프트를 차단한다. .partial()이 각 키를
 * 선택으로 만들되 strictObject의 미정의 키 거부는 보존되므로, 카탈로그 밖 주문번호 키는 에러가 된다.
 */
const buffsShape = Object.fromEntries(
  SPELL_CATALOG.map((entry) => [String(entry.spellNo), buffEntrySchema]),
)

/**
 * 간격 없는 만료-only 상태이상 엔트리 — blind·silence·fear 공용. 셋 다 주기 피해가 아니라
 * 시야 차단·발화 불가·공포라 interval을 갖지 않는다. buffEntrySchema와 셰이프가 같지만 D2 결정
 * (buffs와 statusEffects의 결합 표면 분리)에 따라 상수를 공유하지 않는다 — 두 계약은 독립적으로
 * 진화할 수 있다.
 */
const untilOnlyEffectSchema = z.strictObject({ until: z.int().min(0) })

/**
 * 캐릭터 영속 문서 — 저장의 단일 출처.
 *
 * accountId로 소유 계정(account 문서)을 역참조한다(다대일 FK). 자격증명·권한 인벤토리
 * 배열은 담지 않는다 — 인벤토리는 object.owner(단일 소유권)로부터 파생되므로 여기에 별도
 * 배열을 두지 않고, 인증 자격증명은 account/Firebase가 소유한다.
 * status·deletedAt은 soft-delete 상태를 담는다(하드 삭제 없이 'deleted'로 표시).
 */
export const characterSchema = z.strictObject({
  _id: z.string().min(1),
  name: z.string().min(1),
  class: z.int(),
  race: z.int(),
  // 능력치 5종 고정 튜플 (오라클 순서 유지).
  stats: z.tuple([z.int(), z.int(), z.int(), z.int(), z.int()]),
  gold: z.int().min(0),
  // 현재 방 번호(자연키). data/world 방 로드 경로 번호와 동일 체계.
  currentRoom: z.int().min(0),
  // 전투 필수 영속 필드 3종. gender/weapon은 .optional()이지만(생성 인터뷰 선택),
  // 이 3필드는 전투 resolver가 매 라운드 값을 요구하므로 required다(D3 발산). v1 문서는
  // load 직전 backfillCharacterV2가 승격하고, 신규 문서는 생성 경로에서 시딩한다.
  hpCurrent: z.int().min(0),
  mpCurrent: z.int().min(0),
  level: z.int().min(1),
  // 누적 경험치. level과 동렬의 레벨링 필수 영속 필드(D3 발산)로, progression resolver·train이
  // 값을 요구하므로 required다. v1/v2 문서는 load 직전 backfillCharacterV3가 level 정합값으로
  // 시딩(level<=1이면 0, 아니면 neededExp(level-1))하고, 신규 문서는 생성 경로에서 0으로 시딩한다.
  experience: z.int().min(0),
  // 주문 지식 비트마스크 — uint8[16]=128비트(A6 §8 spells[16]). 비트 f = 주문번호 f의 습득 여부.
  // hpCurrent/experience와 동렬의 영속 필수 필드(D1)로, 학습(study/teach)·시전 게이트가 값을
  // 요구하므로 required다. v4 이하 문서는 load 직전 backfillCharacterV5가 빈 비트마스크(16바이트 0)로
  // 시딩하고, 신규 문서는 생성 경로에서 동일 시드로 배선한다. 비트 read/write 헬퍼는 후속 Story 소유.
  spells: z.array(z.int().min(0).max(255)).length(16),
  // realm[4] 누적경험치 — 흙/바람/불/물 계열 숙련(mstruct.h:195, A6 §5). spells와 동렬의 영속 필수
  // 필드(D1)로, 공격 주문 피해 시 성장 write가 값을 요구하므로 required다. backfillCharacterV5가
  // [0,0,0,0]으로 시딩하고, 신규 문서는 생성 경로에서 동일 시드로 배선한다.
  realm: z.tuple([z.int().min(0), z.int().min(0), z.int().min(0), z.int().min(0)]),
  // 버프/디버프 만료 영속(선택). 주문번호별 {until} 엔트리로, until은 statusEffects와 동일한 절대-틱
  // 만료 관례다(interval 없음 — 버프는 주기 효과가 아니다, D2). strictObject라 카탈로그 밖 키·미정의
  // 키를 거부하고, .partial()로 개별 선택, .optional()로 buffs 자체를 선택으로 둔다(.default 금지 —
  // 추론 타입에서 필수가 돼 기존 픽스처를 깬다. backfillCharacterV5는 statusEffects 선례대로 무시딩).
  buffs: z.strictObject(buffsShape).partial().optional(),
  schemaVersion: z.int(),
  // 소유 계정 id(account._id = Firebase UID)로의 필수 FK.
  accountId: z.string().min(1),
  // soft-delete 상태. 삭제 시 'deleted'로 표시하고 문서는 보존한다.
  status: z.enum(['active', 'deleted']).default('active'),
  // soft-delete 시각. active 문서에는 없다(선택).
  deletedAt: z.coerce.date().optional(),
  // 생성 인터뷰(create_ply)가 고른 성별 — 1=남/2=여. 최소 스칼라 저장(선택; .default 아님 —
  // default는 추론 타입에서 필수가 돼 기존 픽스처를 깨므로 deletedAt처럼 .optional로 둔다).
  gender: z.int().optional(),
  // 생성 시 고른 성향 — 1=선/2=악(단일 스칼라). gender·weapon과 달리 required다(D3 발산): 학습
  // 게이트(study의 OGOODO/OEVILO 판정)와 전투 상태(PlayerCombatState.alignment)가 매 판정마다 값을
  // 요구하므로 부재를 허용하면 소비 지점마다 폴백이 흩어진다. 0은 현 1|2 체계 밖의 중립 sentinel로,
  // E6에서 -1000..+1000 성향 시스템으로 확장할 때 그대로 중립값이 된다(값 재해석 불필요).
  // alignment 없는 v5 이하 문서는 load 직전 backfillCharacterV6가 0으로 시딩하고, 신규 문서는
  // 생성 경로에서 인터뷰 선택값을 저장한다.
  // **값역 제약을 의도적으로 두지 않는다.** 현재 실 데이터 값역은 [0,2](생성 인터뷰 1|2 +
  // backfill sentinel 0)이고 생성 경로는 sessionFsm의 refine(1|2)으로 상류 검증하지만, 이 값역은
  // **한시적 인코딩**이다 — 오라클의 alignment는 부호 있는 int16(`port/templates.js`의
  // `readInt16LE`)이고 소비 규칙들이 이미 그 스케일 임계값(`< -100`·`> 100`·`> 250`·`< -50`)을
  // 보존하고 있다. 여기에 `.min(0).max(2)`를 걸면 (a) 부호가 목표 인코딩과 충돌하고 (b) 레거시
  // 세이브 이식·E6 부분 롤아웃 시 문서가 로드 불가가 된다. 영속 경계는 인코딩 전환을 살아남아야
  // 하므로 상류(생성 FSM)가 도메인을 강제하고 스키마는 정수형만 본다. E6(#123) 참조.
  alignment: z.int(),
  // 생성 시 고른 주력 무기 — 1~5(도/검/봉/창/궁). proficiency[5] 숙련 배열은 E6로 유예한다.
  weapon: z.int().optional(),
  // 상태이상 영속 표현(선택). until은 befuddledUntil/charmedUntil과 동일한 절대-틱 만료
  // 관례다(잔여-틱 아님) — 만료 시점의 절대 틱 값을 저장한다. interval은 주기 피해(poison/
  // disease)의 틱 간격이다. blind는 시야 차단이라 간격이 없어 until만 갖는다. 각 효과는 strictObject라
  // 미정의 키를 거부하고, .partial()로 개별 선택, .optional()로 statusEffects 자체를 선택으로 둔다
  // (.default 금지 — 추론 타입에서 필수가 돼 기존 픽스처를 깬다).
  // silence·fear도 오라클에서 둘 다 dur를 보유하므로(silence는 CAST=3600 고정, fear는 표준 디버프
  // 공식) {until}이 정확한 표현이다. blind와 마찬가지로 주기 피해가 아니라 간격이 없어 interval을
  // 갖지 않는다(blind 선례).
  statusEffects: z
    .strictObject({
      poison: z.strictObject({ until: z.int().min(0), interval: z.int().min(0) }),
      disease: z.strictObject({ until: z.int().min(0), interval: z.int().min(0) }),
      blind: untilOnlyEffectSchema,
      silence: untilOnlyEffectSchema,
      fear: untilOnlyEffectSchema,
    })
    .partial()
    .optional(),
})

export type Character = z.infer<typeof characterSchema>
