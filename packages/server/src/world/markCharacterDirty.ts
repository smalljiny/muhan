import type { Character } from 'shared'

/**
 * characters 컬렉션 markDirty의 단일 계약 지점 — 라이브 캐릭터를 **전체 문서 스냅샷**으로 기록한다.
 *
 * ## 왜 전체 문서인가
 * DirtyTracker는 `collection:id` 키로 마지막 스냅샷만 남기는 LWW 레지스트리다. 호출처마다 서로 다른
 * 부분 스냅샷(`{currentRoom}`·`{gold}`)을 넣으면 나중 mark가 앞선 mark의 필드를 통째로 밀어내
 * write-loss가 난다. 모든 호출처가 같은 전체 문서 형태를 넣으면 코얼레싱이 손실 없이 성립한다.
 * 인자를 `Character`로 좁혀 부분 스냅샷 리터럴을 **컴파일 단계에서** 거부한다.
 *
 * ## 강제 범위(과대 주장 금지)
 * 타입 강제는 이 헬퍼를 소비하는 세 라이브 경로(move 핸들러·세션 lifecycle 어댑터·`TrainDeps`)에
 * 한정된다. 하위 원시 seam `SaveEngine.markDirty(collection, id, snapshot: unknown)`은 여전히 열려
 * 있고 `progression/regen.ts`가 그것을 직접 소비한다(라이브 호출부 0건이라 본 토픽 Non-goal). 즉
 * 계약은 "이 헬퍼를 경유하는 코드"에서 타입으로 강제되고, 원시 seam을 직접 쓰는 신규 코드는 여전히
 * `markDirty('characters', id, {gold})` 같은 부분 스냅샷을 넣을 수 있다. characters 쓰기를 추가할
 * 때는 이 헬퍼를 경유하라.
 *
 * ## 복사 깊이 결정(characterSchema 기준, 필요한 깊이까지만)
 * 라이브 캐릭터는 in-place로 변이되므로(D-A1 carve-out) 스냅샷이 라이브 객체와 별칭을 공유하면
 * mark 이후 변이가 flush 값에 샌다. 반대로 flush 주기마다 도는 경로라 재귀 복제·`structuredClone`은
 * 비용이 과하다. 그래서 **변이 가능한 컨테이너까지만** 끊는다:
 *  - top-level: 얕은 spread(`{...character}`).
 *  - 배열 필드 `stats`(튜플[5])·`spells`(int[16])·`realm`(튜플[4]): 원소가 number라 1단 복사로 충분.
 *  - 객체 필드 `buffs`(주문번호 → `{until}`)·`statusEffects`(poison/disease → `{until, interval}`,
 *    blind → `{until}`): 컨테이너 + **각 엔트리 객체**를 복사한다. 엔트리는 만료 타이머라 in-place로
 *    갱신될 수 있어 컨테이너만 복사하면 별칭이 남는다.
 *  - `deletedAt`(Date)은 **참조를 그대로 둔다** — soft-delete 시각이라 라이브 경로가 in-place로
 *    변이하지 않고(삭제 시 새 Date를 대입한다) 매 flush마다 Date를 재생성할 이유가 없다.
 *
 * ## `status`는 싣지 않는다 — 라이브가 소유하지 않는 필드
 * 규칙: **라이브가 소유하지 않는 필드는 스냅샷이 싣지 않는다.** `status`는 soft-delete 경로
 * (`characterRepository.softDelete`)가 단독으로 소유하는 권한 필드이고, 라이브 경로는 이 값을 변이하지
 * 않는다. 라이브 스냅샷이 `status`를 실으면 LWW에서 **라이브가 삭제 경로를 되돌린다** — 세션이 살아 있는
 * 동안 형제 세션이 그 캐릭터를 삭제하면(계정당 다중 소켓이 허용되고 `assertOwnership`은 라이브 레지스트리를
 * 조회하지 않는다), 뒤이은 이동·종료 flush가 `$set {status:'active'}`로 무덤을 되살려 `findByAccount`의
 * `status: {$ne:'deleted'}` 필터를 다시 통과시킨다. 이는 이 헬퍼가 봉쇄하려는 write-loss의 정확한
 * 역방향이므로, `characterRepository`의 `status.removeDefault()` 방어와 같은 편에 서도록 키를 제외한다.
 *
 * 같은 soft-delete 짝인 `deletedAt`은 **제외하지 않는다** — 위 "복사 깊이" 결정대로 참조를 그대로 싣는다.
 * `status`와 갈리는 이유는 되돌림 가능 여부다: `status`는 스키마 default(`'active'`)가 있어 스냅샷이
 * 실으면 무덤을 **되살리는** 값이 되지만, `deletedAt`은 라이브 스냅샷이 지울 수 없다(라이브 객체에 없으면
 * 키가 `$set`에 실리지 않아 저장 값이 보존된다). 게다가 삭제된 캐릭터는 hydrate되지 않으므로 라이브
 * 객체가 `deletedAt`을 들고 있는 경로 자체가 실질적으로 없다. 따라서 제외 규칙의 대상은 "라이브가
 * 소유하지 않으면서 **실리면 권한 경로의 write를 되돌리는** 필드"이고, 현재 그 유일한 원소가 `status`다.
 *
 * ## 전체 문서라서 함께 실리는 필드(호출처 주의)
 * 부분 스냅샷과 달리 `schemaVersion`도 매 flush마다 `$set`된다. 라이브 캐릭터는 load 시 backfill 체인으로
 * `schemaVersion=5`로 승격돼 있으므로, 첫 flush가 구버전 저장 문서를 v5로 영구 승격시킨다(migration-on-save).
 *
 * ## optional 키 형태 보존
 * 스냅샷은 `updateById` patch로 `$set`에 실리므로, 원본에 없는 키를 `undefined`로 만들면 문서 형태가
 * 바뀐다. `buffs`·`statusEffects`는 값이 있을 때만 대입하고(얕은 spread는 원본에 없는 키를 만들지
 * 않는다), 엔트리 값이 `undefined`인 키도 스냅샷에 만들지 않는다.
 */

/** characters 컬렉션 이름 — 라이브 markDirty 호출처가 공유하는 단일 리터럴. */
export const CHARACTERS_COLLECTION = 'characters'

/** 라이브 markDirty seam(원시). 헬퍼가 감싸는 하위 레이어다. */
export type RawMarkDirty = (collection: string, id: string, snapshot: unknown) => void

/**
 * 타입 좁힌 characters markDirty seam. 인자가 전체 `Character`라 부분 스냅샷은 타입 에러다.
 */
export type MarkCharacterDirty = (id: string, character: Character) => void

type Buffs = NonNullable<Character['buffs']>
type StatusEffects = NonNullable<Character['statusEffects']>
type StatusEffectName = keyof StatusEffects

/** 라이브 스냅샷 형태 — `status`를 제외한 전체 Character 문서(파일 상단 "`status`는 싣지 않는다" 참조). */
export type CharacterSnapshot = Omit<Character, 'status'>

/** buffs 컨테이너 + 각 엔트리 객체를 복사한다. 값이 undefined인 키는 스냅샷에 만들지 않는다. */
function copyBuffs(buffs: Buffs): Buffs {
  const entries: [string, { until: number }][] = []
  for (const [spellNo, entry] of Object.entries(buffs)) {
    if (entry !== undefined) entries.push([spellNo, { ...entry }])
  }
  return Object.fromEntries(entries)
}

/** statusEffects 효과 하나를 원본에서 복사본으로 옮긴다(값이 없으면 키를 만들지 않는다). */
type StatusEffectCopier = (from: StatusEffects, to: StatusEffects) => void

/**
 * statusEffects 키별 복사기 목록. 세 효과는 값 형태가 서로 달라(poison/disease는 interval 보유, blind는
 * 미보유) 인덱스 순회로는 타입이 좁혀지지 않으므로 키별 복사기로 나눈다.
 *
 * `satisfies Record<StatusEffectName, ...>`가 **exhaustive를 컴파일에서 강제**한다 — 스키마에 네 번째
 * 효과가 추가되면 이 리터럴에서 누락 프로퍼티 에러가 난다(조용한 스냅샷 누락 = stale write 재발 방지).
 * copyStatusEffects는 등록된 복사기를 전부 적용하므로 목록에 추가하는 것만으로 반영된다.
 */
const STATUS_EFFECT_COPIERS = {
  poison: (from, to) => {
    if (from.poison !== undefined) to.poison = { ...from.poison }
  },
  disease: (from, to) => {
    if (from.disease !== undefined) to.disease = { ...from.disease }
  },
  blind: (from, to) => {
    if (from.blind !== undefined) to.blind = { ...from.blind }
  },
} satisfies Record<StatusEffectName, StatusEffectCopier>

/** 복사기 목록을 모듈 로드 시 1회 파생한다 — flush 경로에서 호출마다 배열을 재생성하지 않는다. */
const STATUS_EFFECT_COPIER_LIST: readonly StatusEffectCopier[] = Object.values(STATUS_EFFECT_COPIERS)

/** statusEffects 컨테이너 + 각 엔트리 객체를 복사한다(등록된 복사기 전부 적용). */
function copyStatusEffects(effects: StatusEffects): StatusEffects {
  const copy: StatusEffects = {}
  for (const copier of STATUS_EFFECT_COPIER_LIST) copier(effects, copy)
  return copy
}

/**
 * 라이브 캐릭터에서 별칭 없는 스냅샷을 만든다(복사 깊이는 파일 상단 결정 참조).
 * `status`는 라이브가 소유하지 않는 필드라 구조분해로 떨궈 스냅샷에 넣지 않는다.
 */
function snapshotCharacter(character: Character): CharacterSnapshot {
  // 구조분해 rest가 이미 distinct 객체다 — 다시 spread하면 전 필드를 두 번 복사하게 되므로,
  // 갓 만든 이 로컬에 가변 컨테이너만 덮어쓴다(flush 주기 경로라 복사 1회로 줄인다).
  const { status: _status, ...snapshot } = character
  snapshot.stats = [...character.stats]
  snapshot.spells = [...character.spells]
  snapshot.realm = [...character.realm]
  if (character.buffs !== undefined) snapshot.buffs = copyBuffs(character.buffs)
  if (character.statusEffects !== undefined) {
    snapshot.statusEffects = copyStatusEffects(character.statusEffects)
  }
  return snapshot
}

/**
 * 원시 markDirty seam을 characters 전용 seam으로 좁힌다.
 *
 * 반환 함수는 호출 시점의 전체 문서 스냅샷을 떠서 `markDirty('characters', id, snapshot)`으로 넘긴다.
 * 호출처는 스냅샷 복사를 직접 하지 않는다 — distinct 참조 책임은 이 헬퍼가 단독으로 소유한다.
 */
export function createMarkCharacterDirty(markDirty: RawMarkDirty): MarkCharacterDirty {
  return (id: string, character: Character): void => {
    markDirty(CHARACTERS_COLLECTION, id, snapshotCharacter(character))
  }
}
