import type { Character } from 'shared'

/**
 * 전투상태의 hp·mp를 캐릭터 문서에 얹는다 — 라이브 자원값이 영속 문서로 나가는 **단일 경로**다.
 *
 * ## 왜 클램프하는가
 * `combat/combatant.ts`의 피해 차감(`state.hpCurrent -= damage`)에는 하한이 없어 hp가 음수가 될 수
 * 있다. 그런데 받는 쪽 두 계약이 모두 `min(0)`이다 — `characterSchema.hpCurrent`(영속)와 와이어
 * `character:stats.hpCurrent`(프로토콜). 음수가 나가면 (a) 클라이언트가 프레임을 통째로 거부하고
 * (b) 스키마를 위반한 문서가 flush 대상이 된다. **둘 다 예외도 로그도 없이 조용히 실패한다.**
 *
 * 사망 판정에는 영향이 없다 — 전투 규칙은 클램프 전 `state.hpCurrent < 1`을 보고 이미 끝냈다.
 *
 * ## 왜 함수로 뽑았는가
 * 되쓰기 지점이 둘이다: 공격 판정 직후(`ws/handlers/attack.ts`)와 세션 종료 시
 * (`ws/liveSessionLifecycleAdapter.ts`). 각자 병합·클램프를 구현하면 `characterSchema`에 `min(0)`
 * 필드가 하나 더 붙을 때 두 곳을 따로 고쳐야 하고, 한 곳을 빠뜨린 결과가 위의 조용한 실패다.
 * 클램프 불변식과 그 근거를 여기 하나로 모은다.
 *
 * 되쓰기 **직전에 라이브 엔트리를 재조회한다**는 별개 불변식은 호출 지점이 소유한다 — 이 함수는
 * 건네받은 문서에 병합만 하고 레지스트리를 만지지 않는다.
 *
 * 입력을 변형하지 않고 새 문서를 반환한다.
 */
export function applyVitals(
  character: Character,
  vitals: { readonly hpCurrent: number; readonly mpCurrent: number },
): Character {
  return {
    ...character,
    hpCurrent: Math.max(0, vitals.hpCurrent),
    mpCurrent: Math.max(0, vitals.mpCurrent),
  }
}
