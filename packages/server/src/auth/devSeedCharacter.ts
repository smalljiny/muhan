/**
 * dev 시드 캐릭터 영속 문서 빌더.
 *
 * 인메모리 dev 세션 인증이 노출하는 DEV_SEED_CHARACTER에 대응하는 `characters` 문서를 만든다.
 * 필드마다 출처를 고정한다 — 식별·요약 필드는 DEV_SEED_CHARACTER, vitals·spell store·schemaVersion·
 * 시작 방·소지금은 생성 경로와 같은 공유 함수·상수, experience·status·stats·alignment는 시드 고정값이다.
 *
 * 자동으로 드러나는 변경: 반환 타입이 `Character`라서 required 필드가 추가되면 type-check가 실패하고,
 * 값 제약(범위·enum 등)이 바뀌면 저장 시 characterSchema.parse가 부팅을 막는다.
 *
 * 자동으로 드러나지 않는 변경(갱신 조건): 스키마 타입은 그대로인데 값의 의미만 바뀌는 변경은
 * type-check로도 parse로도 드러나지 않는다. 대표적으로 #123이 alignment를 1=선/2=악에서
 * -1000..+1000 스칼라로 바꾸면 시드의 `1`은 그대로 통과하지만 뜻은 "거의 중립"이 된다.
 * 이런 변경을 하는 토픽은 이 모듈의 시드 고정값(stats·alignment)과 유닛 테스트
 * (devSeedCharacter.test.ts)를 함께 갱신해야 한다.
 */
import type { Character } from 'shared'
import { DEV_SEED_CHARACTER } from './devSeedSessionAuth.js'
import { START_ROOM, STARTING_GOLD } from './characterStartDefaults.js'
import {
  CURRENT_CHARACTER_SCHEMA_VERSION,
  seedSpellStore,
  seedVitals,
} from '../repo/characterBackfill.js'
import type { CharacterRepository } from '../repo/characterRepository.js'

/** dev 기본 능력치. 생성 인터뷰를 거치지 않는 시드 고정값이며 비밀이 아니다. */
const DEV_SEED_STATS: Readonly<Character['stats']> = [16, 18, 12, 10, 14]

/** 현재 값 계약(1=선, 2=악) 기준 시드 성향. #123 스칼라화 시 갱신 대상이다. */
const DEV_SEED_ALIGNMENT = 1

/**
 * accountId 소유의 dev 시드 캐릭터 문서를 새 객체로 만든다. 선택 필드
 * (gender·weapon·deletedAt·buffs·statusEffects)는 두지 않는다.
 */
export function buildDevSeedCharacterDoc(accountId: string): Character {
  const { characterId, name, class: characterClass, race, level } = DEV_SEED_CHARACTER
  return {
    _id: characterId,
    name,
    class: characterClass,
    race,
    level,
    ...seedVitals(characterClass, level),
    ...seedSpellStore(),
    schemaVersion: CURRENT_CHARACTER_SCHEMA_VERSION,
    currentRoom: START_ROOM,
    gold: STARTING_GOLD,
    experience: 0,
    status: 'active',
    accountId,
    stats: [...DEV_SEED_STATS],
    alignment: DEV_SEED_ALIGNMENT,
  }
}

/** seedDevCharacter가 쓰는 저장소 표면 — 삽입(없을 때만)과 정규화 조회만 필요하다. */
export type DevSeedCharacterRepo = Pick<CharacterRepository, 'insertIfAbsent' | 'findById'>

/**
 * 기존 시드 문서가 기대 계정 소유의 활성 캐릭터인지 확인하고, 어긋나면 해결 방법을 담은 오류를
 * 던진다. status는 findById 정규화 결과를 쓰므로 필드가 없는 옛 문서는 active다.
 */
function assertSeedConsistent(existing: Character | null, accountId: string): void {
  const id = DEV_SEED_CHARACTER.characterId
  if (existing === null) {
    throw new Error(
      `dev 시드 캐릭터 정합 실패: ${id} 문서를 삽입하지 않았는데 조회되지 않는다. 동시 삭제 여부를 확인하고 다시 부팅하라`,
    )
  }
  if (existing.accountId !== accountId) {
    throw new Error(
      `dev 시드 캐릭터 정합 실패: ${id} 문서의 소유 계정이 다르다 (기대 accountId: ${accountId}, 실제 accountId: ${existing.accountId}). ` +
        `characters 컬렉션에서 ${id} 문서를 삭제하거나 DEV_SEED_ACCOUNT_ID를 ${existing.accountId}로 수정하라`,
    )
  }
  if (existing.status !== 'active') {
    throw new Error(
      `dev 시드 캐릭터 정합 실패: ${id} 문서의 status가 '${existing.status}'이다. 되살리지 않는다. ` +
        `characters 컬렉션에서 ${id} 문서를 삭제한 뒤 다시 부팅하라`,
    )
  }
}

/**
 * dev 시드 캐릭터 문서를 없을 때만 삽입한다. 이미 있으면 덮어쓰거나 되살리지 않고 정합만 확인한다 —
 * 정합하면 'kept'(진행 상태 보존), 어긋나면 throw해 부팅을 실패시킨다. 이름 충돌(E11000)은 삼키지 않는다.
 */
export async function seedDevCharacter(
  repo: DevSeedCharacterRepo,
  accountId: string,
): Promise<'inserted' | 'kept'> {
  if (await repo.insertIfAbsent(buildDevSeedCharacterDoc(accountId))) return 'inserted'

  assertSeedConsistent(await repo.findById(DEV_SEED_CHARACTER.characterId), accountId)
  return 'kept'
}
