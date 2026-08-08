/**
 * 대상 이름 매처 — 오라클 `EQUAL` 매크로(`legacy/muhan/src/mtype.h:579`)의 순수 함수 이식.
 *
 * ```c
 * #define EQUAL(a,b)      ((a) && (b) && \
 *                          (!strncmp((a)->name,(b),strlen(b)) || \
 *                           !strncmp((a)->key[0],(b),strlen(b)) || \
 *                           !strncmp((a)->key[1],(b),strlen(b)) || \
 *                           !strncmp((a)->key[2],(b),strlen(b))))
 * ```
 *
 * 호출 관례(`find_crt`/`find_obj`)는 후보를 선언 순서대로 순회하며 `EQUAL`이면 `match++`,
 * `match === ordinal`인 후보로 확정한다. 끝까지 미달이면 못 찾는다.
 *
 * ## 주문명 매처와 통합하지 않는다
 * `naming/matchSpellName`(`magic1.c:49-70`)과 규칙이 다르다 — 저쪽은 완전일치 특례·모호
 * 거부가 있고 검사 필드가 1개이며 서수가 없다. 두 규칙을 한 함수로 합치면 어느 한쪽이
 * 오라클과 어긋난다.
 *
 * ## 이 함수가 갖지 않는 것 (경계)
 * - **가시성 게이트** — `MINVIS`·`PDINVI`·`PDMINV` 판정은 방 스코프 해소자 책임이다.
 *   **게이트는 이 함수를 부르기 전에 후보를 걸러야 한다.** 오라클은 가시성 판정을 `EQUAL`과
 *   같은 `if` 안에서 AND로 결합하고(`creature.c:43-46`, `object.c:145-147`) DM-invis는 그 앞에서
 *   `continue`한다(`creature.c:39-42`) — 게이트에 걸린 후보는 `match`를 올리지 않는다. 매칭
 *   *후에* 거르면 서수가 밀린다(투명 후보가 앞에 있으면 `공격 고블린 2`가 엉뚱한 대상을 고른다).
 * - **자기 자신 제외·`strlen < 2` 거부** — `command5.c:71-83`의 2단 해소 조건으로 #121 소관.
 * - **질의 첫 바이트 대문자화** — `command5.c:76` `up(cmnd->str[1][0])`는 플레이어 목록 검색
 *   전처리다. 호출부(플레이어 해소자) 책임이며 여기서 하지 않는다.
 * - **완전일치 특례·모호 거부** — `EQUAL`에 없다. 순수 접두 + 선언 순서가 그대로 서수다.
 *
 * 순수 함수다. 입력 배열·객체를 변형하지 않고 전역 상태를 읽지 않는다.
 */

/** 매처가 보는 후보의 최소 형상 — 크리처·아이템·플레이어 타입에 무관하다. */
export interface NameMatchable {
  readonly name: string
  /** 별칭 `key[0..2]`. 플레이어처럼 별칭이 없는 대상은 미보유(`undefined`)다. */
  readonly keys?: readonly string[]
}

/** `EQUAL` 한 후보 판정 — `name`·`keys` 중 하나라도 `query`를 접두로 가지면 참. */
function equals(candidate: NameMatchable, query: string): boolean {
  if (candidate.name.startsWith(query)) return true
  // keys 미보유면 name 단독 검사로 끝난다(플레이어 해소자 계약).
  return candidate.keys?.some((key) => key.startsWith(query)) ?? false
}

/**
 * 후보 중 `query`를 접두로 갖는 `ordinal`번째를 반환한다. 미달이면 `undefined`.
 *
 * `query`가 빈 문자열이면 `strncmp(a, b, 0) === 0`이라 전 후보에 매치한다 — 오라클 그대로다.
 */
export function matchTarget<T extends NameMatchable>(
  candidates: readonly T[],
  query: string,
  ordinal = 1,
): T | undefined {
  let match = 0
  for (const candidate of candidates) {
    if (!equals(candidate, query)) continue
    match++
    if (match === ordinal) return candidate
  }
  return undefined
}
