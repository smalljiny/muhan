import { spellByNo, type Character, type ClientCommand, type ServerEvent } from 'shared'
import type { CommandHandler } from '../router.js'
import type { ActorContext } from '../actorContext.js'
import type { LiveCharacterRegistry } from '../../world/liveCharacterRegistry.js'
import type { MarkCharacterDirty } from '../../world/markCharacterDirty.js'
import type { MarkObjectDeleted } from '../../save/markObjectDeleted.js'
import type { ObjectTemplateIndex } from '../../items/objectTemplate.js'
import { resolveCarriedObject } from '../../items/carriedTargetResolver.js'
import { composeCharacterFlags } from '../../character/flags.js'
import { study, type StudyFailure } from '../../magic/learning.js'
import { makeErrorEvent } from '../serverEvent.js'

/**
 * study 핸들러 의존성 seam(전역 금지 — 인자 주입).
 *
 * `liveRegistry`는 라이브 캐릭터 단일 출처다. 핸들러가 소비하는 두 메서드 `get`·`register`만 요구한다
 * (최소 표면) — `register`는 학습한 spells와 비법서를 뺀 인벤으로 엔트리를 교체하는 데 쓴다.
 * `objectTemplates`는 objnum → 템플릿 인덱스로, 소지품 이름 해소와 비법서 스탯(type·ndice·magicpower·
 * flags)의 출처다. `now`는 현재 절대 틱 seam으로, 관찰자 P-flag 합성 시점을 준다(worldClock 도메인).
 * `markCharacterDirty`·`markObjectDeleted`는 write-behind 영속화 seam으로, 성공 경로에서만 각 1회 소비한다.
 */
export interface StudyHandlerDeps {
  readonly liveRegistry: Pick<LiveCharacterRegistry, 'get' | 'register'>
  readonly objectTemplates: ObjectTemplateIndex
  readonly now: () => number
  readonly markCharacterDirty: MarkCharacterDirty
  readonly markObjectDeleted: MarkObjectDeleted
}

/**
 * 거부 사유의 사람용 한국어 message — study() 실패 6종 + 해소 실패(`not-found`)를 빠짐없이 사상한다
 * (`Record`가 누락을 컴파일에서 막는다 — train 핸들러 `REJECT_MESSAGES` 선례).
 *
 * 문구는 오라클 `study`(`legacy/muhan/src/magic1.c:259-342`)를 따른다. 줄번호는 전부 **거부 메시지를
 * 출력하는 `print` 행**을 가리킨다(게이트 조건 행이 아니다 — 기준 통일). 두 곳만 오라클과 다르다:
 *  - `alignment`: 오라클 문구는 비법서가 화염에 휩싸여 사라졌다고 말하지만 이 포트는 아이템을
 *    소모하지 않으므로(아래 divergence ②) 그 서술을 쓰면 message가 거짓이 된다.
 *  - `no-spell`: 오라클에 대응 분기가 없다(그 입력은 `spllist[-1]`을 읽는다). study()가 추가한
 *    방어 게이트라 문구도 여기서 짓는다.
 */
const REJECT_MESSAGES: Record<StudyFailure | 'not-found', string> = {
  // magic1.c:296 — 1·2단 탐색이 모두 빈손일 때.
  'not-found': '그런 것을 소지하고 있지 않습니다',
  // magic1.c:274
  blind: '당신의 능력으로는 이 비법서를 연마할 수 없습니다',
  // magic1.c:301
  'not-a-book': '이것은 비법서가 아닙니다',
  // magic1.c:307
  level: '당신의 능력으로는 이 비법서의 내용을 파악하지 못해 연마할 수 없습니다',
  alignment: '당신의 성향과 맞지 않아 이 비법서를 연마할 수 없습니다',
  // magic1.c:324
  class: '당신의 직업상 이 비법을 연마할 수 없습니다',
  'no-spell': '이 비법서에는 익힐 수 있는 주문이 담겨 있지 않습니다',
}

/**
 * `progress:study{target, ordinal?, id?}` 명령을 실 주문 학습으로 배선하는 핸들러 팩토리.
 *
 * 게임 규칙 판정(PBLIND → SCROLL 여부 → 레벨 → 정렬 → 클래스 → 주문 존재 6게이트와 지식 비트 세팅)은
 * 전부 `magic/learning`의 `study()`가, 대상 지목(인벤 → 착용 슬롯 2단 탐색·가시성 게이트·서수)은
 * `items/carriedTargetResolver`가 소유한다 — 핸들러는 라이브 상태 조회·flags 합성·결과 사상·영속 마킹만 한다.
 *
 * ## 관찰자 flags는 **1회만** 합성한다
 * `composeCharacterFlags(live.character, deps.now())`의 결과를 해소자 `observerFlags`와 `StudyChar.flags`
 * 양쪽에 넘긴다. 두 번 합성하면 두 `now()` 사이에 타이머 효과가 만료돼, 가시성 판정(PDINVI)과 실명
 * 판정(PBLIND)이 서로 다른 시점을 보게 된다.
 *
 * ## 템플릿 미해소는 internal이 아니다
 * `ObjectInstance`에 `name`·`keys`가 없어 템플릿 미해소 인스턴스는 원리적으로 이름이 없고, 질의 시점에
 * "미소지"와 구분할 수단이 없다. 해소자가 후보에서 빼고 별도로 보고하지 않으므로(그 근거는
 * `items/carriedTargetResolver.ts` 헤더가 소유한다) 이 핸들러도 미해소를 배선 오류로 승격하지 않고
 * `not-found`와 같은 거부로 응답한다.
 *
 * ## 마킹 순서 — characters 먼저, objectDeletions 나중
 * 성공 경로는 `markCharacterDirty` → `markObjectDeleted` 순으로 마킹한다. 캐릭터 문서에 지식 비트가
 * 먼저 남아야, 두 write 사이에 프로세스가 죽어도 "주문은 못 배웠는데 비법서만 사라진" 상태가 되지 않는다
 * (역순의 손실은 되돌릴 수 없고, 이 순서의 손실은 비법서가 남아 다시 연마하면 되는 자가 치유형이다 —
 * `study()`의 `setKnown`이 멱등이라 재연마가 안전하다).
 *
 * ⚠ 이 순서 보장은 코얼레싱 의미론에 걸려 있다: dirty 레지스트리는 Map이라 **각 키의 최초 삽입 위치**를
 * 보존한다(최신이 아니다). 따라서 순서가 지켜지는 것은 각 키의 *최초* 마킹이 올바른 순서로 나갈 때뿐이다.
 *
 * ⚠ 이 핸들러는 주기 flush 경로(`markObjectDeleted`)만 쓰고 `saveNow`를 부르지 않는다. 삭제 멱등성이
 * 경로별로 비대칭이기 때문이다 — 주기 flush는 `DocumentNotFoundError`를 permanent로 폐기하지만
 * `saveNow`는 rethrow한다. 즉 재연마·중복 마킹이 무해한 것은 주기 경로에 한정된다.
 *
 * ## 미재현 divergence 3건
 * ① **`PHIDDN` 해제 미재현** — 오라클은 연마 성공 시 `F_CLR(ply_ptr, PHIDDN)`(magic1.c:328)으로 은신을
 *    푼다. 이 포트의 `composeCharacterFlags`는 **타이머 보유 효과 전용**이라 `PHIDDN`에 영속 경로가 없고
 *    (`character/flags.ts` 파티션 표의 마지막 행 — 구조적으로 봉쇄된 비트), 따라서 세울 수도 해제할 수도
 *    없다. 그 비트의 영속 표현이 정해지기 전에는 재현 불가다. <!-- 추적 이슈: #121 -->
 * ② **정렬 실패 시 방 낙하 유예** — 오라클은 `alignment` 실패 시 비법서를 손에서 떼어 방 바닥에 떨어뜨린다
 *    (`del_obj_crt` + `add_obj_rom`, magic1.c:315-316). 이 포트의 `objectOwnerSchema`에는 room owner가
 *    없어(`character`|`bank` 둘뿐) 아이템을 방으로 옮길 표현 자체가 없으므로 인벤에 잔류시킨다. **즉
 *    alignment 거부는 아이템을 소모하지 않는다** — 다른 거부 사유와 동일하게 상태 무변이다. 방 바닥
 *    아이템 상태는 이 토픽 범위 밖이고(스펙 §5), 게다가 현 `alignment` 값역이 `[0,2]`라 이 게이트 자체가
 *    구조적으로 미발화하므로 지금은 관측되지 않는다. <!-- 추적 이슈: #123 (값역), 방 owner 표현은 미개설 -->
 * ③ **성공 시 방 브로드캐스트 미재현** — 오라클은 연마 성공을 방 전체에 알린다(magic1.c:333-334,
 *    `%M이 %1i의 내용을 읽고 연마합니다`). 이 핸들러는 발화자 본인에게만 `progress:studied`를 낸다.
 *    누락이 아니라 **와이어에 대응 이벤트가 없어서**다 — `ServerEvent`에 방 스코프 "누가 무엇을
 *    했다" 통지가 없다. 재현하려면 프로토콜 확장(version bump)이 선행돼야 한다. <!-- 추적 이슈: #116 -->
 *
 * 반환:
 *   - 성공 → `progress:studied{...}`(상태 이벤트, correlationId 없음 — progress:trained 선례).
 *   - 게임 규칙 거부·대상 미해소 → `error{rule_rejected, message}`(id 있으면 correlationId 반향).
 *   - 라이브 미등록 actor → `error{internal}`(배선 격리 — 게임 규칙 거부와 구분).
 */
export function createStudyHandler(deps: StudyHandlerDeps): CommandHandler {
  return (command: ClientCommand, actor: ActorContext): ServerEvent | undefined => {
    // (1) defensive narrow — router는 progress:study type에만 이 핸들러를 배선하므로 false 갈래는
    //     구조적으로 도달 불가한 방어선이다.
    if (command.type !== 'progress:study') return undefined

    // (2) 라이브 캐릭터 단일 출처 조회. 미등록 actor는 연마 불가 — internal로 격리한다.
    const live = deps.liveRegistry.get(actor.characterId)
    if (live === undefined) {
      return makeErrorEvent('internal', '캐릭터 라이브 상태를 찾을 수 없습니다', command.id)
    }

    // (3) 관찰자 P-flag를 1회 합성해 해소자와 study() 양쪽에 같은 스냅샷을 넘긴다(위 헤더 참조).
    const observerFlags = composeCharacterFlags(live.character, deps.now())

    // (4) 대상 지목 — 오라클 2단 탐색(인벤 find_obj → ready 착용 슬롯). `ordinal` 미지정은 해소자
    //     기본값 1로 떨어진다(와이어 스키마가 하한 1을 강제하므로 0은 도달 불가).
    const found = resolveCarriedObject(
      live.inventory,
      deps.objectTemplates,
      command.target,
      observerFlags,
      command.ordinal,
    )
    if (found === undefined) {
      return makeErrorEvent('rule_rejected', REJECT_MESSAGES['not-found'], command.id)
    }

    // (5) 게임 규칙 판정 일체를 study()에 위임한다. 입력은 순수 필드 5개이고 반환은 새 spell store다
    //     (study()는 char·book을 변형하지 않는다).
    const result = study(
      {
        level: live.character.level,
        class: live.character.class,
        alignment: live.character.alignment,
        spells: live.character.spells,
        flags: observerFlags,
      },
      found.template,
    )

    // (6) 거부 — 게임 규칙 거부(D-D). `ok`가 boolean이라 그것으로는 `failure`가 좁혀지지 않으므로
    //     `failure`를 직접 판별한다(study() 계약상 `failure !== null`과 `!ok`는 동치다).
    //     study()는 거부 시 store를 그대로 돌려주므로 라이브 상태·마킹 모두 불변이다.
    if (result.failure !== null) {
      return makeErrorEvent('rule_rejected', REJECT_MESSAGES[result.failure], command.id)
    }

    // (7) 표시용 주문 이름. study()의 마지막 게이트가 카탈로그 멤버십을 이미 확인했으므로 여기서
    //     undefined는 도달 불가하지만, 비-null 단언 대신 배선 오류로 격리한다(계약이 갈리면 신호를 준다).
    const spellNo = found.template.magicpower - 1
    const entry = spellByNo(spellNo)
    if (entry === undefined) {
      return makeErrorEvent('internal', '주문 정보를 찾을 수 없습니다', command.id)
    }

    // (8) 라이브 엔트리 교체 — 학습한 spells를 실은 새 Character + 소모된 인스턴스를 뺀 새 인벤.
    //     `{ ...live }`로 나머지 필드를 그대로 옮긴다(train 핸들러 선례 — 새 객체를 통째로 만들면
    //     이 토픽 밖의 필드가 조용히 사라진다). stats·realm은 참조 그대로 실려 튜플 계약이 보존된다.
    //     `[...result.spells]`는 방어 복사가 아니라 타입 폭 맞춤이다 — study()는 `readonly number[]`를
    //     돌려주는데 `Character.spells`는 가변 `number[]`다(setKnown이 이미 새 배열을 준다).
    const character: Character = { ...live.character, spells: [...result.spells] }
    const inventory = live.inventory.filter((instance) => instance._id !== found.instance._id)
    deps.liveRegistry.register({ ...live, character, inventory })

    // (9) 영속 마킹 — characters 먼저, objectDeletions 나중(위 헤더 "마킹 순서" 참조).
    deps.markCharacterDirty(actor.characterId, character)
    deps.markObjectDeleted(found.instance._id)

    return {
      type: 'progress:studied',
      spellNo,
      spellName: entry.koreanName,
      spells: character.spells,
      consumedObjectId: found.instance._id,
    }
  }
}
