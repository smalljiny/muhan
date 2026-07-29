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
 * **이 모듈이 규약의 정본이다** — `combat/`·`magic/` 프로덕션 소스는 `character/flags.js`를 import하지
 * 않는다. `character/`가 두 모듈을 소비하는 상위 배선 계층이므로 역방향 간선은 곧 순환이다. 투영이
 * 필요한 하위 모듈은 각자의 `project*Flags`를 직접 쓰고, 조립 헬퍼(`toPlayerCombatState`)는 합성 hex를
 * **인자로만** 받는다.
 *
 * 확인(import 문만 매칭): `grep -rn "from '.*character/flags" packages/server/src/combat
 * packages/server/src/magic --include='*.ts'` → 프로덕션 소스 0건. 테스트 파일은 이 제약 밖이라
 * 매칭될 수 있다 — 테스트는 런타임 모듈 그래프에 들어가지 않아 순환을 만들지 않는다. 매칭 건수를
 * 여기 적지 않는 이유는, 테스트가 하나 늘 때마다 문서가 거짓이 되기 때문이다(불변식만 진술한다).
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
 * | (미소유 — 영속 경로 부재) | 없음 | PHIDDN(1)·PDMINV(10)·PWIMPY(14)·PCHAOS(28)·PFAMIL(55)·PUPDMG(59) |
 *
 * ### ⚠ 마지막 행은 "아직 안 함"이 아니라 **구조적으로 봉쇄**된 상태다
 * 이 모듈은 raw `flags` hex 영속 필드를 두지 않는 것을 규약으로 삼는다(위 참조). 그런데 마지막 행의
 * 비트들은 `statusEffects`·`buffs` 어디에서도 파생되지 않는 **비-타이머 성격 플래그**라, 현 아키텍처에
 * 영속 경로 자체가 없다. 즉 `composeCharacterFlags`는 이 비트들을 **영원히 0으로 반환한다**.
 *
 * 그럼에도 소비자는 이미 존재한다 — `combat/pvp.ts`의 `checkPvpGate`가 `F_ISSET(attacker.flags, PCHAOS)`와
 * `F_ISSET(..., PFAMIL)`을 읽는다. 따라서 후속 배선 토픽이 이 표를 "flags의 완전한 출처"로 읽고
 * `PlayerCombatState.flags`에 합성 hex를 **유일 출처로** 배선하면, PCHAOS 미세팅으로 선악 PvP 동의
 * 게이트가 영구 거부되고 PFAMIL 미세팅으로 패거리 전쟁 판정(`checkWarResult`)이 한 번도 호출되지 않는다.
 * 지금은 `flags: ''`라 동작이 같아 회귀로 드러나지 않는다는 점이 이 함정의 핵심이다.
 *
 * 이 비트들의 영속 표현(전용 명명 필드 vs raw hex 필드 예외)은 별도 결정이며 본 토픽 범위 밖이다 —
 * 배선 전에 먼저 정해야 한다.
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
