/**
 * objectDeletions 컬렉션 markDirty의 단일 계약 지점 — 영속 오브젝트 1건의 **삭제 의도**를 기록한다.
 *
 * ## 왜 별도 seam인가
 * 원시 seam `SaveEngine.markDirty(collection, id, snapshot: unknown)`은 collection·snapshot이 모두
 * 열려 있어 호출처가 컬렉션 리터럴을 오타내거나 임의 스냅샷을 실을 수 있다. 삭제는 되돌릴 수 없는
 * write라 진입점을 하나로 좁힌다 — `markCharacterDirty`가 characters에 대해 하는 역할의 삭제판이다.
 *
 * ## 툼스톤 스냅샷을 싣는 이유
 * `objectDeletions` 어댑터는 id만 쓰고 snapshot을 무시한다(`deleteById(id)`). 그럼에도 스냅샷을
 * `{_id, deleted:true}` 툼스톤으로 채우는 것은 큐 job이 "빈 삭제 마킹"이 아니라 삭제 의도를 자기
 * 기술하게 하기 위해서다. ⚠ 현재 로그 경로(`AsyncWriteQueue`·`SaveEngine`)는 `{collection,id,err}`만
 * 싣고 스냅샷을 기록하지 않으므로, 이 툼스톤은 **디버거에서만 보인다** — 로그 확장 여지일 뿐 지금
 * 관측 실효가 있는 것은 아니다. 스냅샷은 참조로 저장되므로(AsyncWriteQueue 계약) 호출마다 새 객체를
 * 만들어 호출 간 별칭을 남기지 않는다.
 *
 * ## objectId 형태 가드
 * 어댑터가 id를 Mongo `_id` 필터에 그대로 싣기 때문에, 객체가 유입되면 연산자 주입(`{$ne:...}`)으로
 * 임의 문서를 삭제 대상 삼을 수 있다. `SaveEngine.saveNow`의 `assertSaveId`와 동일한 가드를 이
 * 헬퍼에도 둔다(defense-in-depth, security.md).
 *
 * **강제 범위(과대 주장 금지)**: 가드는 이 헬퍼를 경유하는 호출에만 걸린다. 원시 seam
 * `SaveEngine.markDirty('objectDeletions', badId, …)`를 직접 부르는 경로는 여전히 열려 있다
 * (`markCharacterDirty`가 characters에 대해 갖는 한계와 동일). 전 경로를 덮으려면 가드가
 * `SaveEngine.markDirty` 안으로 내려가야 한다.
 *
 * ## Non-goal
 * 메커니즘만 전달한다 — 삭제를 유발하는 게임플레이 호출처(연마로 인한 비법서 소모 등)는 여기에
 * 추가하지 않는다.
 */

/** objectDeletions 컬렉션 이름 — 라이브 삭제 호출처가 공유하는 단일 리터럴. */
export const OBJECT_DELETIONS_COLLECTION = 'objectDeletions'

/** 라이브 markDirty seam(원시). 헬퍼가 감싸는 하위 레이어다. */
export type RawMarkDirty = (collection: string, id: string, snapshot: unknown) => void

/** 타입 좁힌 objectDeletions markDirty seam. 스냅샷은 헬퍼가 소유하므로 인자가 id뿐이다. */
export type MarkObjectDeleted = (objectId: string) => void

/**
 * objectId가 비어 있지 않은 문자열인지 검증한다(파일 상단 "objectId 형태 가드" 참조).
 */
function assertObjectId(objectId: string): void {
  if (typeof objectId !== 'string' || objectId.length === 0) {
    throw new Error(
      `markObjectDeleted objectId는 비어 있지 않은 문자열이어야 합니다: ${String(objectId)}`,
    )
  }
}

/**
 * 원시 markDirty seam을 objectDeletions 전용 seam으로 좁힌다.
 *
 * 반환 함수는 objectId 형태를 검증한 뒤 툼스톤 스냅샷을 새로 떠
 * `markDirty('objectDeletions', objectId, {_id, deleted:true})`로 넘긴다.
 */
export function createMarkObjectDeleted(markDirty: RawMarkDirty): MarkObjectDeleted {
  return (objectId: string): void => {
    assertObjectId(objectId)
    markDirty(OBJECT_DELETIONS_COLLECTION, objectId, { _id: objectId, deleted: true })
  }
}
