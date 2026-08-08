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
  | 'name'
  | 'level'
  | 'hpmax'
  | 'mpmax'
  | 'dexterity'
  | 'gold'
  | 'special'
  | 'armor'
  | 'thaco'
  | 'ndice'
  | 'sdice'
  | 'pdice'
  | 'flags'
  // 마법 읽기 필드(Story 2) — 소스 JSON에 존재하는 4개만 Pick한다. realm은 소스에 없으므로
  // 제외하고 materialize가 상수 기본값을 채운다(아래 주석 참조).
  | 'spells'
  | 'class'
  | 'intelligence'
  | 'piety'
  // 사망 분배 읽기 필드(Story 6) — creatures.json / rooms.json monsters[]에 항상 존재한다.
  // CreatureInstance에서 optional이라 Pick 결과도 optional이지만, 소스는 항상 값을 보유하므로
  // materialize가 실값을 옮긴다. Story 7 사망 처리가 킬 경험치·정렬 변동에 읽는다.
  | 'experience'
  | 'alignment'
  // 이름 매칭용 별칭(Story 4) — creatures.json / rooms.json monsters[]에 항상 존재한다(별칭이
  // 없으면 빈 배열). CreatureInstance에서 optional이라 Pick 결과도 optional이며, materialize가
  // 부재 시 빈 배열로 정규화한다.
  | 'keys'
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
    // 전투 스탯(D6) — 소스에서 그대로 옮긴다(콘텐츠 불변). embedded는 templateId=null이라 재조회 불가.
    armor: src.armor,
    thaco: src.thaco,
    ndice: src.ndice,
    sdice: src.sdice,
    pdice: src.pdice,
    // 마법 읽기 필드(Story 2) — spells·class·intelligence·piety는 소스에서 그대로 옮긴다(콘텐츠 불변).
    // realm은 소스 JSON에 없으므로 상수 [0,0,0,0]을 기본값으로 채운다 — port readCrt가 offset 380
    // realm을 추출하지 않아 정본 값이 전 몬스터 0이며, 이 기본값은 추출 결과와 byte-identical이다.
    // 실 realm 추출·성장 write(addrealm)는 #85 소관이다.
    spells: src.spells,
    class: src.class,
    intelligence: src.intelligence,
    piety: src.piety,
    realm: [0, 0, 0, 0],
    // 사망 분배 읽기 필드(Story 6) — 소스에서 그대로 옮긴다(콘텐츠 불변). 소스 JSON이 항상
    // 두 키를 보유하므로 실값을 채운다(Story 7 킬 경험치·정렬 변동 입력).
    experience: src.experience,
    alignment: src.alignment,
    // 이름 매칭용 별칭(Story 4) — 소스에서 옮긴다(콘텐츠 불변). 소스에 없어도 빈 배열로
    // 정규화한다(undefined 금지 — 대상 매처가 두 형상을 분기하지 않도록). 배열은 인스턴스마다
    // 복사한다 — 같은 템플릿에서 스폰된 전 인스턴스가 한 배열을 공유하지 않게(realm 선례).
    keys: [...(src.keys ?? [])],
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
