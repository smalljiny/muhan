import { matchTarget, type CreatureInstance, type RoomNode } from 'shared'
import { F_ISSET, MINVIS, PDMINV, PDINVI } from './hexFlags.js'

/**
 * 방 스코프 대상 해소자 — 오라클 `creature.c:29-60 find_crt`의 가시성 게이트를 얹어 방 안 크리처·
 * 플레이어를 한글 이름으로 지목한다. 매칭 규칙 자체(4필드 순수 접두 + 서수)는 순수 매처
 * `shared/naming/matchTarget`이 소유하고 이 모듈은 **후보 선별**만 한다.
 *
 * ```c
 * cp = first_ct;
 * while(cp) {
 *     if(cp->crt->class >= CARETAKER && F_ISSET(cp->crt, PDMINV)) {
 *         cp = cp->next_tag;
 *         continue;                                  // 결합 조건 — match++ 안 함
 *     }
 *     if(EQUAL(cp->crt, str) &&
 *        (F_ISSET(ply_ptr, PDINVI) ? 1 : !F_ISSET(cp->crt, MINVIS))) {
 *         match++;
 *         if(match == val) { found = 1; break; }
 *     }
 *     cp = cp->next_tag;
 * }
 * ```
 *
 * ## 게이트는 매칭 **앞**이다 (구현 순서가 곧 계약)
 * 두 게이트 모두 `match++` 앞에 있으므로 걸린 후보는 **서수 슬롯을 소모하지 않는다**. 그래서 이 모듈은
 * 후보 배열을 먼저 거른 뒤 `matchTarget`에 넘긴다(순서 보존). 매칭 *후에* 거르면 투명 후보가 앞에 있을 때
 * `고블린 2`가 엉뚱한 대상을 고른다 — `matchTarget` 헤더가 같은 경계를 반대편에서 기술한다.
 *
 * ## 관찰자 flags는 인자다
 * 해소자가 `composeCharacterFlags`를 호출하지 않는다 — 호출부(배선 계층)가 합성한 16자 P-flag hex를
 * 넘긴다(`combat/playerState.ts:56,95` 선례). `now` 의존성을 순수 해소자 밖에 두어 이 모듈이 시간에
 * 무관한 순수 함수로 남는다.
 *
 * ## ⚠ 여기서 **구현하지 않는** 경계 3건 — 소비 토픽이 조립한다
 * `roomView.ts`의 "관찰자 비의존이 봉인한 두 게이트" 주석과 같은 취지다. 누락이 아니라 소유권 분리이며,
 * 여기에 미리 넣으면 소비 토픽의 게이트와 중복·충돌한다.
 *
 * 1. **플레이어 후보 가시성 게이트** — 오라클 `EQUAL`은 `first_ply` 순회에도 같은 가시성 판정을 적용하지만,
 *    `PHIDDN`(은신)·`PINVIS`(투명)·`PDMINV`(DM 투명) 점유자 필터는 **표시 경로(`roomView.ts`)와 함께 #129가
 *    소유한다**. 두 경로가 같은 관찰자 인자 설계를 공유해야 하므로 한 토픽에서 함께 연다. 그때까지 이
 *    플레이어 해소자는 이름이 해소되는 점유자를 무조건 후보로 싣는다(크리처 해소자와 비대칭 — 함정).
 * 2. **자기 자신 제외** — `command5.c:79`의 `crt_ptr == ply_ptr` 거부는 #121(attack 2단 해소) 몫이다.
 *    이 해소자는 관찰자 characterId를 인자로 받지 않으며 후보에서 자신을 빼지 않는다.
 * 3. **`strlen(str) < 2` 거부** — `command5.c:79` 동일 조건(1바이트 접두로 플레이어 지목 차단)도 #121 몫이다.
 *    질의가 빈 문자열이면 `strncmp(a,b,0) === 0`이라 첫 후보에 매치한다(오라클 그대로).
 *
 * 덧붙여 `command5.c:76`은 플레이어 목록 검색 **전에** `cmnd->str[1][0] = up(cmnd->str[1][0])`로 질의 첫
 * 바이트를 대문자화한다(영문 플레이어명 관례, 한글에는 무효). 질의 전처리도 호출부(#121) 책임이라 이
 * 모듈은 질의를 받은 그대로 매처에 넘긴다.
 *
 * 생존 게이트(`hpcur > 0`)도 두지 않는다 — `find_crt`에 없고, 사망 개체 제거는 `creatureDeath`가 소유한다
 * (표시 경로 `roomView.ts`가 별도로 거르는 것과 의도된 비대칭이다). 같은 이유로 `MHIDDN`(은신) 게이트도
 * 없다 — `roomView.isCreatureHidden`은 `MHIDDN`을 거르지만 `find_crt`에는 없어서, **숨은 크리처는 방
 * 목록에 안 보여도 이름으로는 지목된다**. 오라클 그대로이므로 여기서 맞추지 않는다.
 *
 * ## ⚠ 알려진 divergence — 서수 기준 순서
 * 오라클 `first_ply`·`first_mon`은 도착 순서 리스트가 아니라 **`strcmp` 이름 정렬 삽입 리스트**다
 * (`room.c:17-19` 주석 "alphabetically", `add_ply_rom` room.c:58-72, `add_crt_rom` room.c:246-261).
 * 즉 오라클 서수는 이름 사전순이고, 동률 이름은 나중 진입이 뒤에 온다(`> 0`에서만 break).
 *
 * 이 포트는 도착 순서를 쓴다 — 플레이어는 `room.occupants`(Set) 삽입 순서, 크리처는 `room.creatures`
 * push 순서다(초기 방 로드는 `read_rom` 파일 순서와 일치하지만 런타임 스폰·리스폰·소환은 전부 push다).
 * 정렬을 넣지 않는 이유: `strcmp`는 EUC-KR 바이트 비교인데 KS X 1001 완성형 배열과 Unicode Hangul
 * Syllables 배열이 달라 JS 문자열 비교로 재현되지 않는다 — collation 테이블 없이는 이식이 불가능하다.
 *
 * 영향 범위는 **질의 접두가 같고 이름이 다른 후보가 공존할 때의 서수뿐**이다(예: `고블린`·`고블린 대장`이
 * 한 방에 있고 질의가 `고`). 이름이 전부 같은 흔한 경우에는 차이가 없다. 별도 이슈로 추적한다.
 */

/**
 * CARETAKER(초인) 클래스 인덱스 — `mtype.h:103 #define CARETAKER 10`. 모듈 로컬 상수로 둔다
 * (`packages/shared/src/progression/maxResolvers.ts:15` 선례 — 배럴에 노출하지 않는다).
 */
const CARETAKER = 10

/** characterId → 표시 이름 해소자(라이브 레지스트리 조회 seam). 미접속·미해소 id에는 `undefined`. */
export type ResolveCharacterName = (characterId: string) => string | undefined

/** 방 스코프 플레이어 해소자 — 질의·서수로 방 점유자 characterId를 고른다. */
export type RoomPlayerResolver = (
  room: RoomNode,
  query: string,
  ordinal?: number,
) => string | undefined

/**
 * 방 스코프 크리처 해소자 — 질의·관찰자 flags·서수로 방 안 크리처를 고른다.
 * `RoomPlayerResolver`와 대칭인 명시 계약이다(구현 시그니처에 종속되는 `typeof` 대신).
 */
export type RoomCreatureResolver = (
  room: RoomNode,
  query: string,
  observerFlags: string,
  ordinal?: number,
) => CreatureInstance | undefined

/**
 * `find_crt` 가시성 게이트 — 후보 자격이 있으면 true.
 *
 * ① DM 투명: `class >= CARETAKER`와 비트 10의 **결합(AND)**이다. 어느 한쪽만 참인 크리처는 후보로 남는다
 *    — `creatures.json` 실측으로 `class >= 10`은 52마리, 비트 10은 50마리지만 교집합은 0건이라
 *    `class` 단독으로 축약하면 52마리가 잘못 스킵된다.
 *
 *    **비트 10의 정체 주의**: C `F_ISSET(p,f)`(mtype.h:566)는 구조체 무관 매크로라 오라클도 몬스터
 *    리스트 순회에서 `F_ISSET(cp->crt, PDMINV)`를 그대로 호출한다. 그런데 `PDMINV`(mtype.h:355)는
 *    P-flag 공간의 "DM Invisibility"이고, 크리처 flags(M-flag 공간)의 같은 비트 10은 `MFLEER`
 *    (mtype.h:421, "Monster flees")다. 즉 위 "50마리"는 DM 투명이 아니라 `MFLEER` 보유 몬스터다.
 *    `MFLEER`는 C 소스에 `F_SET` 경로가 없고(빌더·DM 도구가 세팅) 읽기만 두 곳에 있다 —
 *    `creature.c:632`(직전 무조건 `return`으로 사실상 죽은 코드)와 `dm2.c:398`(DM 플래그 표시).
 *    이 비트 겹침은 오라클의 성질이므로 그대로 이식한다.
 * ② 투명: 관찰자가 `PDINVI`(투명 감지)를 들면 무조건 통과, 아니면 크리처의 `MINVIS`가 없어야 한다.
 */
function isCreatureTargetable(creature: CreatureInstance, observerFlags: string): boolean {
  if (creature.class >= CARETAKER && F_ISSET(creature.flags, PDMINV)) return false
  if (F_ISSET(observerFlags, PDINVI)) return true
  return !F_ISSET(creature.flags, MINVIS)
}

/**
 * 방 안 크리처를 이름(별칭 포함)·서수로 해소한다. 게이트에 걸린 후보를 **먼저** 제외한 배열을
 * `matchTarget`에 넘긴다(선언 순서 보존 = 서수 기준).
 *
 * 순수 함수다 — `room`과 그 하위 배열·객체를 변형하지 않고 새 배열만 만든다.
 *
 * @param room 대상 방(라이브 노드)
 * @param query 사용자가 친 이름 접두(질의 전처리는 호출부 소유 — 위 경계 3건 참조)
 * @param observerFlags 관찰자 P-flag hex 스냅샷. 호출부가 `composeCharacterFlags(character, now)`로 합성해 넘긴다
 * @param ordinal 몇 번째 매치를 고를지(1-base, 오라클 `val`). 미달이면 `undefined`
 */
export const resolveRoomCreature: RoomCreatureResolver = (
  room,
  query,
  observerFlags,
  ordinal = 1,
) => {
  const targetable = room.creatures.filter((creature) =>
    isCreatureTargetable(creature, observerFlags),
  )
  return matchTarget(targetable, query, ordinal)
}

/**
 * 방 점유자(플레이어) 해소자를 만든다 — 주입된 이름 해소자로 표시 이름을 얻어 후보를 세우고
 * `matchTarget`에 위임한다. 매치된 후보에서 characterId를 꺼내 돌려준다.
 *
 * 이름이 해소되지 않는(미접속·빈 문자열) 점유자는 후보에서 빠지며 서수 슬롯도 소모하지 않는다.
 * 후보는 `name`만 갖는다(`keys` 미보유) — 오라클 `EQUAL`은 `first_ply`에도 `key[]`를 검사하나 플레이어
 * 세이브의 key는 실무상 비어 있어 `characterSchema`에 별칭 필드를 두지 않는다(**의도된 divergence**).
 * `matchTarget`은 `keys` 미보유 후보를 `name` 단독으로 검사한다.
 *
 * 서수 기준은 `room.occupants`(Set)의 **도착 순서**다. 오라클 `first_ply`는 이름 정렬 삽입 리스트라
 * 서수가 사전순이다 — 모듈 헤더의 "알려진 divergence" 절 참조.
 *
 * @param resolveCharacterName 배선 계층이 1회 생성해 공유하는 이름 해소자(liveWorldWiring 불변식 #3)
 */
export function createRoomPlayerResolver(
  resolveCharacterName: ResolveCharacterName,
): RoomPlayerResolver {
  return (room, query, ordinal = 1) => {
    const candidates: { characterId: string; name: string }[] = []
    for (const characterId of room.occupants) {
      const name = resolveCharacterName(characterId)
      // 빈 문자열은 이름이 아니다 — 접두 매칭에서 모든 질의를 흡수해 서수를 밀어낸다.
      if (name) candidates.push({ characterId, name })
    }
    return matchTarget(candidates, query, ordinal)?.characterId
  }
}
