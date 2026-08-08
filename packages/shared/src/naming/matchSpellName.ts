/**
 * 주문명 매처 — 오라클 `legacy/muhan/src/magic1.c:49-70`의 순수 함수 이식.
 *
 * ```c
 * do {
 *     if(!strcmp(cmnd->str[1], spllist[c].splstr)) {   // 완전일치
 *         match = 1;                                   // 누적을 1로 리셋
 *         splno = c;
 *         break;                                       // 즉시 종료
 *     }
 *     else if(!strncmp(cmnd->str[1], spllist[c].splstr, strlen(cmnd->str[1]))) {
 *         match++;                                     // 접두 누적
 *         splno = c;
 *     }
 *     c++;
 * } while(spllist[c].splno != -1);
 *
 * if(match == 0)      → "그런 주문은 존재하지 않습니다."
 * else if(match > 1)  → "펼치실 주문의 이름이 이상하군요."
 * ```
 *
 * 완전일치는 누적을 **1로 리셋하고 즉시 break**한다 — 그래서 선언 순서와 무관하게 이긴다.
 * 진접두 형제(`X`와 `X…`)가 있을 때 이 리셋이 없으면 `X` 질의가 모호로 잘못 거부된다.
 *
 * ## 대상 매처와 통합하지 않는다
 * `naming/matchTarget`(`mtype.h:579` EQUAL)과 규칙이 다르다 — 저쪽은 완전일치 특례가 없고
 * 검사 필드가 4개(`name`·`key[0..2]`)이며 모호 거부 대신 서수로 고른다.
 *
 * ## 소비자
 * cast(`magic1.c:49`, `str[1]`)와 teach(`magic1.c:163`, `str[2]`)가 같은 do-while을 문자
 * 그대로 복제한 코드다 — 이 함수 하나가 양쪽을 덮는다.
 *
 * 순수 함수다. 입력 배열·객체를 변형하지 않고 전역 상태를 읽지 않는다.
 */

/** 매처가 보는 카탈로그 엔트리의 최소 형상 — `SpellEntry` 전체를 요구하지 않는다. */
export interface SpellNameEntry {
  readonly spellNo: number
  readonly koreanName: string
}

/**
 * 주문명 매칭 결과 — 오라클의 세 분기(확정 / 모호 거부 / 부재)를 `kind` 태그로 판별한다.
 * 호출자는 `ambiguous`·`notFound`에 각각 오라클 메시지를 대응시킨다.
 */
export type SpellNameMatch =
  | { readonly kind: 'found'; readonly spellNo: number }
  | { readonly kind: 'ambiguous' }
  | { readonly kind: 'notFound' }

/**
 * `query`로 주문 엔트리를 해소한다. 완전일치 우선, 그 외에는 유일 접두일 때만 확정한다.
 *
 * `query`가 빈 문자열이면 `strncmp(a, b, 0) === 0`이라 전 엔트리에 접두 일치한다 —
 * 거부 게이트를 넣지 않고 오라클 동작을 그대로 둔다(엔트리 2개 이상이면 모호가 된다).
 */
export function matchSpellName(entries: readonly SpellNameEntry[], query: string): SpellNameMatch {
  let match = 0
  let spellNo: number | undefined

  for (const entry of entries) {
    if (entry.koreanName === query) {
      match = 1
      spellNo = entry.spellNo
      break
    } else if (entry.koreanName.startsWith(query)) {
      // C의 `else if` 그대로다 — 완전일치는 접두 분기로 흘러들지 않는다.
      match++
      spellNo = entry.spellNo
    }
  }

  if (match === 0 || spellNo === undefined) return { kind: 'notFound' }
  if (match > 1) return { kind: 'ambiguous' }
  return { kind: 'found', spellNo }
}
