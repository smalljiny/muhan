/**
 * 문서 저장소 공통 계약.
 *
 * T는 저장소가 다루는 문서 타입이며, 문서의 `_id`가 Mongo `_id`로 그대로 매핑된다.
 *
 * 생성자 주입 관례: 구현체는 mongodb `Db`를 생성자로 주입받는다
 * (`constructor(private readonly db: Db)`). 서비스 로케이터나 전역 싱글턴을 통해
 * 연결을 조회하지 않는다 — 테스트에서 mongodb-memory-server의 Db를 그대로 넣어
 * 격리 실행할 수 있게 하기 위함이다.
 */
export interface IRepository<T> {
  /** id로 단건 조회. 없으면 null. */
  findById(id: string): Promise<T | null>
  /** 신규 문서 삽입. 구현체는 저장 경계에서 런타임 검증을 수행한다. */
  insert(doc: T): Promise<void>
  /**
   * id로 부분 갱신($set 시맨틱). `_id`는 불변이라 patch에서 제외한다
   * (Mongo immutable-_id 에러를 타입 단계에서 차단). 구현체는 부분 문서도 경계 검증한다.
   */
  updateById(id: string, patch: Partial<Omit<T, '_id'>>): Promise<void>
  /** id로 삭제. */
  deleteById(id: string): Promise<void>
}
