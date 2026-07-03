/**
 * 변경 엔티티 추적기(side registry).
 *
 * 변경된 도메인 엔티티를 도메인 객체 자체에 `.dirty` 플래그를 심지 않고, 외부 레지스트리
 * `Map<"collection:id", { collection, id, snapshot }>`에 기록한다(불변성 — coding-style.md).
 * 같은 `collection:id` 키로 여러 번 markDirty하면 last-write-wins로 coalescing되어, 한 저장
 * 주기 동안 키당 최신 스냅샷 1건만 남는다. drain()이 스케줄러/셧다운 시점에 전체를 배열로
 * 뽑아내며 레지스트리를 비운다(Node 단일 스레드라 원자적).
 *
 * 스냅샷 타입은 저장소별 문서 형태(characters·bankAccounts·roomStates)가 달라 특정 도메인
 * 타입에 묶지 않고 `unknown`으로 유연하게 받는다.
 *
 * 호출 계약(중요): markDirty에는 **그 시점의 스냅샷**을 넘긴다 — 라이브 도메인 객체 참조를
 * 넘기면 안 된다. 이 프로젝트는 라이브 상태를 인메모리 객체 그래프로 유지하므로, 같은 키에
 * 라이브 참조를 반복 전달하면 coalescing이 무의미해지고(모든 mark가 동일 mutating 객체를
 * 별칭) drain()이 mark 시점이 아닌 drain 시점 상태를 영속화한다. 스냅샷은 참조 그대로
 * 보관되며 복제하지 않는다.
 */

/**
 * 레지스트리 항목 — 저장 대상 컬렉션·id와 그 시점의 문서 스냅샷.
 * 소비자(스케줄러·큐)가 항목을 mutate하지 못하도록 readonly로 노출한다.
 */
export interface DirtyEntry {
  readonly collection: string
  readonly id: string
  readonly snapshot: unknown
}

export class DirtyTracker {
  private readonly registry = new Map<string, DirtyEntry>()

  /**
   * collection·id 엔티티를 dirty로 기록한다. 같은 키 재호출 시 이전 스냅샷을 덮어써
   * last-write-wins로 coalescing한다. 전달된 snapshot은 mutate하지 않고 참조를 그대로 보관한다.
   */
  markDirty(collection: string, id: string, snapshot: unknown): void {
    // 키는 collection·id가 콜론(:)을 포함하지 않는다고 가정한다 — collection은 고정 리터럴
    // (characters·bankAccounts·roomStates), id는 Mongo hex 또는 한글 이름이라 성립한다.
    const key = `${collection}:${id}`
    this.registry.set(key, { collection, id, snapshot })
  }

  /**
   * 현재 pending 항목 전체를 배열로 반환하고 registry를 비운다.
   *
   * 파괴적 연산이다 — drain된 항목은 tracker에서 사라진다. 소비자(AsyncWriteQueue·
   * SaveEngine)의 비동기 write가 실패하면 그 항목은 여기 없으므로, 소비자가 보유한
   * 스냅샷으로 다시 `markDirty`해 requeue해야 한다. 단, drain 이후 같은 키가 새 스냅샷으로
   * 재-markDirty된 경우, 실패-requeue(과거 스냅샷)가 그 최신 스냅샷을 last-write-wins로
   * 덮어쓰지 않도록 최신 mark가 우선해야 한다.
   */
  drain(): readonly DirtyEntry[] {
    const entries = Array.from(this.registry.values())
    this.registry.clear()
    return entries
  }

  /** pending 항목 개수. */
  get size(): number {
    return this.registry.size
  }
}
