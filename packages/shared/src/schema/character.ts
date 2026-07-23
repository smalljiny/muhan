import { z } from 'zod'

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
  // 전투 필수 영속 필드 3종. gender/weapon/alignment는 .optional()이지만(생성 인터뷰 선택),
  // 이 3필드는 전투 resolver가 매 라운드 값을 요구하므로 required다(D3 발산). v1 문서는
  // load 직전 backfillCharacterV2가 승격하고, 신규 문서는 생성 경로에서 시딩한다.
  hpCurrent: z.int().min(0),
  mpCurrent: z.int().min(0),
  level: z.int().min(1),
  // 누적 경험치. level과 동렬의 레벨링 필수 영속 필드(D3 발산)로, progression resolver·train이
  // 값을 요구하므로 required다. v1/v2 문서는 load 직전 backfillCharacterV3가 level 정합값으로
  // 시딩(level<=1이면 0, 아니면 neededExp(level-1))하고, 신규 문서는 생성 경로에서 0으로 시딩한다.
  experience: z.int().min(0),
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
  // 생성 시 고른 성향 — 1=선/2=악(단일 스칼라). -1000..+1000 성향 시스템은 E6로 유예한다.
  alignment: z.int().optional(),
  // 생성 시 고른 주력 무기 — 1~5(도/검/봉/창/궁). proficiency[5] 숙련 배열은 E6로 유예한다.
  weapon: z.int().optional(),
  // 상태이상 영속 표현(선택). until은 befuddledUntil/charmedUntil과 동일한 절대-틱 만료
  // 관례다(잔여-틱 아님) — 만료 시점의 절대 틱 값을 저장한다. interval은 주기 피해(poison/
  // disease)의 틱 간격이다. blind는 시야 차단이라 간격이 없어 until만 갖는다. 각 효과는 strictObject라
  // 미정의 키를 거부하고, .partial()로 개별 선택, .optional()로 statusEffects 자체를 선택으로 둔다
  // (.default 금지 — 추론 타입에서 필수가 돼 기존 픽스처를 깬다).
  statusEffects: z
    .strictObject({
      poison: z.strictObject({ until: z.int().min(0), interval: z.int().min(0) }),
      disease: z.strictObject({ until: z.int().min(0), interval: z.int().min(0) }),
      blind: z.strictObject({ until: z.int().min(0) }),
    })
    .partial()
    .optional(),
})

export type Character = z.infer<typeof characterSchema>
