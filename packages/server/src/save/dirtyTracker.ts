/**
 * 변경 엔티티 추적기(side registry).
 *
 * 변경된 도메인 엔티티를 도메인 객체 자체에 `.dirty` 플래그를 심지 않고, 외부 레지스트리
 * `Map<"collection:id", { collection, id, snapshot }>`에 기록한다(불변성 — coding-style.md).
 * 같은 `collection:id` 키로 여러 번 markDirty하면 last-write-wins로 coalescing되어, 한 저장
 * 주기 동안 키당 최신 스냅샷 1건만 남는다. 소비 경로는 아래 수명 계약을 따른다.
 *
 * 수명 계약(registry / inProgress 2단 소유):
 *   스냅샷은 markDirty부터 write 종결까지 tracker 안에 **연속 존재**해야 한다. 중간에 사라지면
 *   재접속 hydrate가 아직 영속되지 않은 진행도를 못 보고 과거 문서를 읽어 진행도가 되돌아간다.
 *   그래서 소비 경로는 두 맵을 오간다(각 맵의 역할은 필드 선언부 주석 참조).
 *   checkout()은 registry에 대해 파괴적·원자적이라 동시 flush가 겹쳐도 서로소 집합을 가져간다.
 *   조회는 peek() 한 곳으로 하며 registry를 먼저 본다 — checkout 이후 재-mark된 최신 스냅샷이
 *   in-flight 과거 스냅샷보다 항상 우선한다. 반납은 checkout()이 내준 엔트리 자체를 토큰으로
 *   삼는다(조건은 release() 주석 참조).
 *
 * 스냅샷 타입은 저장소별 문서 형태(characters·bankAccounts·roomStates)가 달라 특정 도메인
 * 타입에 묶지 않고 `unknown`으로 유연하게 받는다.
 *
 * 호출 계약(중요): markDirty에는 **그 시점의 스냅샷**을 넘긴다 — 라이브 도메인 객체 참조를
 * 넘기면 안 된다. 이 프로젝트는 라이브 상태를 인메모리 객체 그래프로 유지하므로, 같은 키에
 * 라이브 참조를 반복 전달하면 coalescing이 무의미해지고(모든 mark가 동일 mutating 객체를
 * 별칭) 소비 시점이 mark 시점이 아닌 소비 시점 상태를 영속화한다. 스냅샷은 참조 그대로
 * 보관되며 복제하지 않는다.
 */

/**
 * 레지스트리·큐 공통 키 포맷 — `collection:id`.
 *
 * collection·id가 콜론(:)을 포함하지 않는다고 가정한다 — collection은 고정 리터럴
 * (characters·bankAccounts·roomStates), id는 Mongo hex 또는 한글 이름이라 성립한다.
 *
 * DirtyTracker와 AsyncWriteQueue가 **같은 논리 키**로 같은 엔트리를 가리켜야 하는 것이 계약이다.
 * SaveEngine.saveNow가 tracker.evict와 queue.evict를 짝지어 부르는데, 두 키가 어긋나면 evict가
 * 절반만 듣고 write-loss 봉쇄가 예외도 로그도 없이 무너진다. 그래서 포맷을 여기 한 곳에 둔다.
 */
export function dirtyKey(collection: string, id: string): string {
  return `${collection}:${id}`
}

/**
 * 레지스트리 항목 — 저장 대상 컬렉션·id와 그 시점의 문서 스냅샷.
 * 소비자(스케줄러·큐)가 항목을 mutate하지 못하도록 readonly로 노출한다.
 *
 * checkout()이 내준 이 객체가 곧 반납 토큰이다 — ack/discard는 키가 아니라 이 참조를 받는다.
 */
export interface DirtyEntry {
  readonly collection: string
  readonly id: string
  readonly snapshot: unknown
}

export class DirtyTracker {
  /** 미착수 스냅샷 — markDirty가 쌓고 checkout()이 통째로 비운다. */
  private readonly registry = new Map<string, DirtyEntry>()
  /** write 진행 중 스냅샷 — checkout()이 이관하고 ack/discard가 종결 시 지운다. */
  private readonly inProgress = new Map<string, DirtyEntry>()

  /**
   * collection·id 엔티티를 dirty로 기록한다. 같은 키 재호출 시 이전 스냅샷을 덮어써
   * last-write-wins로 coalescing한다. 전달된 snapshot은 mutate하지 않고 참조를 그대로 보관한다.
   */
  markDirty(collection: string, id: string, snapshot: unknown): void {
    this.registry.set(dirtyKey(collection, id), { collection, id, snapshot })
  }

  /**
   * pending 항목 전체를 배열로 반환하고, 같은 엔트리를 inProgress로 이관하며 registry를 비운다.
   *
   * registry에 대해 파괴적·원자적이라 동시 flush가 겹쳐도 서로소 집합을 가져간다. 다만 반환한
   * 엔트리가 tracker에서 사라지지는 않고 inProgress에 남아, write가 끝날 때까지 peek()으로
   * 조회된다. 소비자는 write 종결 시 그 엔트리를 그대로 넘겨 ack(성공) 또는 discard(폐기)를
   * 호출해 소유권을 반납해야 한다 — 반납하지 않으면 그 키는 다음 checkout이 덮어쓸 때까지
   * inProgress에 남는다.
   *
   * 이관된 키가 이후 새 스냅샷으로 재-markDirty되면 registry에 별도로 쌓이며, peek()이
   * registry를 먼저 보므로 최신 스냅샷이 우선한다.
   *
   * 반환 배열은 Map 삽입 순서다 — 소비자가 이 순서대로 write를 시도한다.
   */
  checkout(): readonly DirtyEntry[] {
    const entries: DirtyEntry[] = []
    // registry.entries()로 돌아 이미 보관된 키를 그대로 쓴다 — 엔트리마다 키를 재계산하면
    // "맵의 키"와 "필드에서 재계산한 키"라는 두 진실 원천이 생긴다.
    for (const [key, entry] of this.registry) {
      this.inProgress.set(key, entry)
      entries.push(entry)
    }
    this.registry.clear()
    return entries
  }

  /**
   * in-flight 스냅샷의 소유권을 반납한다 — ack/discard 공통 경로.
   *
   * inProgress에 담긴 엔트리가 인자와 **같은 참조**일 때만 제거하고, 아니면 no-op이다. 키 K가
   * S1으로 in-flight인 동안 K가 S2로 재-mark되고 다음 checkout이 S2를 이관하면, 뒤늦게 도착한
   * S1의 종결 통지는 no-op이 되어 아직 write되지 않은 S2가 살아남는다.
   *
   * 키를 인자로 받지 않고 entry에서 도출하는 이유: 키와 엔트리가 어긋난 호출은 조용한 no-op이
   * 되어 반납 누락이 예외도 로그도 없이 지나간다. 도출로 바꾸면 그 조합 자체가 표현 불가능해진다.
   */
  private release(entry: DirtyEntry): void {
    const key = dirtyKey(entry.collection, entry.id)
    if (this.inProgress.get(key) === entry) this.inProgress.delete(key)
  }

  /** write 성공을 통지해 in-flight 스냅샷의 소유권을 반납한다. 조건은 release() 참조. */
  ack(entry: DirtyEntry): void {
    this.release(entry)
  }

  /**
   * write 폐기(영구 실패·재시도 소진·어댑터 미발견)를 통지해 소유권을 반납한다.
   *
   * 조건은 release()와 같다. 스냅샷은 복구되지 않고 버려지므로, 이후 peek()은 undefined를
   * 반환하고 그 키는 DB 문서가 최신이라는 계약으로 되돌아간다.
   */
  discard(entry: DirtyEntry): void {
    this.release(entry)
  }

  /**
   * 해당 키의 미영속 스냅샷을 비파괴적으로 조회한다(없으면 undefined).
   *
   * registry를 먼저 보고 없을 때만 inProgress를 본다 — checkout 이후 재-mark된 최신 스냅샷이
   * in-flight 과거 스냅샷보다 우선한다. undefined는 "미영속 스냅샷 없음"을 뜻하며, 수명 계약상
   * 그 키는 저장소 문서가 최신이라는 의미다.
   */
  peek(collection: string, id: string): DirtyEntry | undefined {
    const key = dirtyKey(collection, id)
    return this.registry.get(key) ?? this.inProgress.get(key)
  }

  /**
   * 단일 collection·id 항목을 registry·inProgress 양쪽에서 제거한다(없으면 no-op).
   *
   * SaveEngine.saveNow가 즉시 write 직전에 호출한다. registry 제거는 write-loss 봉쇄다 —
   * markDirty로 쌓인 stale 스냅샷이 이후 주기 flush로 꺼내져 saveNow의 최신 write를 덮어쓰는
   * 것을 막는다. inProgress 제거가 지키는 것은 그와 별개인 **읽기 측** 불변식이다 — evict
   * 이후 peek()이 saveNow가 쓴 값보다 오래된 스냅샷을 반환하지 않는다. checkout된 write 자체의
   * 취소·완료 대기는 tracker가 못 하며 `AsyncWriteQueue.evict`가 담당한다(saveEngine.ts 참조).
   */
  evict(collection: string, id: string): void {
    const key = dirtyKey(collection, id)
    this.registry.delete(key)
    this.inProgress.delete(key)
  }

  /**
   * pending(미착수) 항목 개수. checkout으로 이관된 항목은 세지 않는다.
   *
   * 주의: `size + inProgressSize`는 미영속 키의 개수가 아니다 — checkout 후 재-mark된 키는
   * 두 맵에 동시에 있어 두 번 세어진다. 키 단위 판정은 peek()으로 한다.
   */
  get size(): number {
    return this.registry.size
  }

  /** write 진행 중(checkout 후 미종결) 항목 개수 — 관측용. 위 size 주의 문구 참조. */
  get inProgressSize(): number {
    return this.inProgress.size
  }
}
