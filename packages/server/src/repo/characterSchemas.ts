/**
 * characters 컬렉션의 공유 검증 스키마 — 의존 0 모듈.
 *
 * `characterRepository.ts`가 아니라 여기 두는 이유는 소비자가 둘이기 때문이다. 영속 경로
 * (`CharacterRepository.updateById`)와 재접속 hydrate의 pending overlay(#124)가 **같은 인스턴스**로
 * 검증해야 하는데, 후자는 `world/` 계층에 있다. 저장소 구현 모듈에 두면 `world/`가 `repo/` 구현을
 * 런타임 의존하게 되고, 그건 이 서버에서 유일한 계층 역전 엣지가 된다(`world/`·`ws/`는 저장소를
 * 구조적 타입으로만 받는다 — `LiveWorldWiringBundle.characterRepo` 참조).
 *
 * `repo/types.ts`와 같은 지위다 — 저장소 계층이 소유하되 의존이 없어 어느 계층이든 안전하게
 * 소비할 수 있는 공유물.
 */
import { characterSchema } from 'shared'

/**
 * 부분 갱신 검증 스키마 — updateById마다 재구성하지 않도록 모듈 스코프에서 1회 파생한다.
 *
 * strictObject의 `.partial()`은 존재 필드만 검증하고 unknown 키는 여전히 거부한다.
 * status의 `.default('active')`는 먼저 벗긴다(accountRepository와 동일 관례): patch에 status가
 * 없을 때 `.partial()`이라도 default가 재발화해 `$set`에 `status:'active'`가 주입되면, 무덤
 * (status='deleted') 문서를 부활시키는 silent write가 된다. removeDefault로 넘긴 값만 검증한다.
 *
 * 재접속 hydrate(#124)가 pending 스냅샷을 검증할 때 **이 인스턴스를 그대로 재사용**한다.
 * 소비처에서 재파생하면 영속 경로(updateById)와 검증 기준이 갈라지고, 그 불일치는 예외도
 * 로그도 남기지 않는다(overlay는 통과했는데 flush에서 거부되는 식).
 */
export const characterPatchSchema = characterSchema
  .extend({ status: characterSchema.shape.status.removeDefault() })
  .partial()
