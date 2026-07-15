import type { CreatureInstance } from 'shared'

/**
 * 크리처 인스턴스 팩토리 — 크리처 템플릿/embedded 몬스터를 라이브 `CreatureInstance`로 물질화한다.
 *
 * 두 출처(spec §2, 플랜 T2.2):
 *   (a) `fromEmbedded` — 방 파일에 박힌 완전한 creature 구조체(빌더 커스터마이즈, `templateId=null`).
 *   (b) `fromTemplate` — `creatures.json`을 id로 조회(perm/random 스폰·MSUMMO 소환용, `templateId`=id).
 *
 * instanceId는 결정적(`${roomId}:c${idx}`, Math.random/Date.now 미사용, ItemInstance instanceId 선례).
 * carry/gold 랜덤화(A9 §17)는 주입 `rng` seam으로 위임하며 기본 stub은 결정적 identity다 —
 * 실 loot 굴림은 E6이 다른 `CreatureRng`를 주입해 대체한다(전투/loot 범위 밖, `defaultFleeRng` 선례).
 */

/**
 * 물질화 입력 소스의 최소 shape. 방 embedded 몬스터(rooms.json `monsters[]`, T2.0 전체 필드)와
 * 크리처 템플릿(creatures.json 엔트리)이 모두 구조적으로 이 타입을 만족한다(추가 필드 무시).
 *
 * `CreatureInstance`와 겹치는 8개 스탯 필드는 `Pick`으로 파생해 자동 동기화한다 — 인스턴스 쪽
 * 필드 이름/타입이 바뀌면 이 입력 타입도 함께 이동해 구조적 호환 계약이 컴파일 시점에 유지된다.
 */
export type CreatureSource = Pick<
  CreatureInstance,
  'name' | 'level' | 'hpmax' | 'mpmax' | 'dexterity' | 'gold' | 'special' | 'flags'
>

/**
 * carry/gold 랜덤화 seam. base gold(템플릿/embedded 값)를 받아 실제 소지 gold를 반환한다.
 * 기본 stub은 결정적 identity(base 그대로) — 단위 테스트가 결정적으로 통과한다.
 */
export type CreatureRng = (baseGold: number) => number

/** 결정적 기본 rng — gold를 랜덤화하지 않고 그대로 둔다. E6이 실 굴림으로 대체. */
export const defaultCreatureRng: CreatureRng = (baseGold) => baseGold

/** 결정적 instanceId 생성 — 방 id + 방 내 인덱스. 방 id가 유일하고 idx가 방 내 유일해 전역 유일. */
function creatureInstanceId(roomId: number, idx: number): string {
  return `${roomId}:c${idx}`
}

/**
 * 공통 물질화 — 소스 스탯을 라이브 인스턴스로 옮긴다. hpcur=hpmax·mpcur=mpmax(스폰 시 만신),
 * enemies는 빈 배열(E6 전투가 채우는 seam), 타이머 필드는 미설정(Story 3 next-action 큐가 세팅).
 */
function materialize(
  src: CreatureSource,
  roomId: number,
  idx: number,
  templateId: number | null,
  rng: CreatureRng,
): CreatureInstance {
  return {
    instanceId: creatureInstanceId(roomId, idx),
    templateId,
    name: src.name,
    level: src.level,
    hpmax: src.hpmax,
    hpcur: src.hpmax,
    mpmax: src.mpmax,
    mpcur: src.mpmax,
    dexterity: src.dexterity,
    gold: rng(src.gold),
    special: src.special,
    flags: src.flags,
    enemies: [],
    // inventory는 라이브 가변 배열(scavenge 회수분·Story 5 드롭 출처). 스폰 시 빈 배열이며,
    // embedded 몬스터의 초기 소지품 물질화는 별도(아이템 에픽) 소관이다.
    inventory: [],
  }
}

/**
 * (a) 방 embedded 몬스터를 라이브 인스턴스로 물질화한다. `templateId=null`(인라인 데이터라
 * 템플릿 링크 없음). embedded 스탯은 빌더 커스터마이즈로 템플릿과 다를 수 있으므로 그대로 쓴다.
 */
export function fromEmbedded(
  src: CreatureSource,
  roomId: number,
  idx: number,
  rng: CreatureRng = defaultCreatureRng,
): CreatureInstance {
  return materialize(src, roomId, idx, null, rng)
}

/**
 * (b) 템플릿 번호로 `creaturesById`를 조회해 물질화한다(perm/random 스폰·MSUMMO 소환).
 * 알 수 없는 id면 undefined(호출측이 스폰을 건너뛴다). `templateId`=조회 id.
 */
export function fromTemplate(
  templateId: number,
  roomId: number,
  idx: number,
  rng: CreatureRng,
  creaturesById: ReadonlyMap<number, CreatureSource>,
): CreatureInstance | undefined {
  const src = creaturesById.get(templateId)
  if (src === undefined) return undefined
  return materialize(src, roomId, idx, templateId, rng)
}
