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
