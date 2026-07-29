import { type Character } from 'shared'
import { orFlags } from '../world/hexFlags.js'
import { projectStatusFlags } from '../combat/statusEffects.js'
import { projectResistFlags, projectBuffFlags } from '../magic/buffEffects.js'

/**
 * character/flags — 캐릭터 P-flag hex의 **합성 계층**. 영속 필드(statusEffects·buffs)에서 파생된 세
 * 투영을 OR해 소비측이 F_ISSET로 읽는 단일 16자 hex를 만든다.
 *
 * ## 왜 합성인가 — raw flags 영속 필드를 두지 않는다
 * characterSchema에 raw `flags` hex 필드를 추가하지 않는다. 추가하면 예컨대 PBLIND(42)가
 * statusEffects.blind와 flags 두 곳에서 표현돼 drift(한쪽만 갱신되는 이중 출처)가 생긴다. 명명 필드가
 * 정본이고 hex는 항상 파생값이다.
 *
 * ## 순수 함수 — 캐시·메모이제이션 없음
 * 결과는 (character, now)의 함수이며 now는 매 틱 변한다. 캐시를 두면 만료 경계에서 stale 비트를
 * 돌려주므로 무효화 규칙이 곧 재계산과 같아진다. 조기 최적화를 피해 매 호출 재산출한다.
 *
 * ## 의존 방향 — 배선 계층만 소비한다 (순환 의존 부재)
 * `character/`는 `combat/`·`magic/`을 소비하는 상위 배선 계층이고, 역방향 간선은 없다. 확인:
 * `grep -rn "character/flags" packages/server/src/combat packages/server/src/magic` → 0건. 이 방향을
 * 유지한다 — combat/magic이 composeCharacterFlags를 부르기 시작하면 순환이 생기므로, 투영이 필요한
 * 하위 모듈은 각자의 project*Flags를 직접 쓴다.
 *
 * ## 비트 소유권 파티션 (스펙 §3.1)
 * 각 비트의 생산자는 정확히 하나다. 세 소유 집합은 서로소이며, 아래 표에 없는 비트는 어떤 입력에서도
 * 세팅되지 않는다.
 *
 * | 출처 | 영속 필드 | 소유 비트 |
 * |---|---|---|
 * | `projectStatusFlags` | `statusEffects` | PPOISN(16)·PDISEA(41)·PBLIND(42)·PFEARS(43)·PSILNC(44) |
 * | `projectResistFlags` | `buffs`(저항 4주문) | PRFIRE(30)·PRMAGI(32)·PRCOLD(36)·PSSHLD(38) |
 * | `projectBuffFlags` | `buffs`(타이머 10주문) | PBLESS(0)·PINVIS(2)·PPROTE(8)·PLIGHT(17)·PDMAGI(20)·PDINVI(21)·PLEVIT(25)·PFLYSP(31)·PKNOWA(33)·PBRWAT(37) |
 * | (미소유 — 범위 밖) | — | PHIDDN(1)·PDMINV(10)·PWIMPY(14)·PCHAOS(28)·PFAMIL(55)·PUPDMG(59) |
 *
 * PFEARS(43)·PSILNC(44)의 생산자는 `projectStatusFlags` 단독이다 — `magic/buffEffects.ts`의
 * `TIMED_BUFF_META`에 SFEARS/SSILNC를 추가하지 않는다(추가하면 두 투영이 같은 비트를 생산해 이중
 * 출처가 된다). 이 금지는 flags.test.ts가 SFEARS·SSILNC buffs 엔트리를 직접 활성화해 아무 비트도 서지
 * 않음을 고정하는 회귀 케이스로 강제한다(소유 비트 정확일치만으로는 **등재 추가** 드리프트를 못 잡는다).
 *
 * 새 비트는 파티션 표에 먼저 등재한다(표 갱신 → 소유 투영 지정 → 구현 순서). 표에 없는 비트를 어느
 * 투영이 세팅하기 시작하면 flags.test.ts의 소유권 테스트가 실패한다.
 */

/**
 * composeCharacterFlags — 캐릭터의 상태이상·저항·버프 투영을 OR한 16자 P-flag hex를 반환한다.
 *
 * 세 투영 모두 16자 폭에서 시작하고 `orFlags`가 8바이트를 고정 순회하므로 반환 폭은 항상 16자다
 * (고바이트 절단 없음 — PFEARS 43·PSILNC 44는 byte 5, PFAMIL 55는 byte 6에 안착).
 * 만료된 효과는 각 투영이 이미 제외하므로 여기서 별도 만료 판정을 하지 않는다.
 *
 * @param character 판독 대상 캐릭터(입력 불변 — 각 투영은 fresh hex를 만든다).
 * @param now 현재 절대 틱. 각 투영의 `until >= now` 활성 판정 기준.
 */
export function composeCharacterFlags(character: Character, now: number): string {
  return orFlags(
    orFlags(projectStatusFlags(character, now), projectResistFlags(character, now)),
    projectBuffFlags(character, now),
  )
}
