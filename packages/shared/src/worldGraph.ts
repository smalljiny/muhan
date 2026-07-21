/**
 * 인메모리 월드 그래프 타입 — 부팅 시 방 데이터를 로드해 구성하는 런타임 객체 그래프.
 *
 * 영속 스키마(objectSchema/ObjectInstance 등)와는 별개다. 이쪽은 zod가 아닌 순수 TS
 * 타입으로, 디스크에 저장되지 않는 라이브 상태(런타임 필드·생성 id)를 표현한다.
 *
 * 가변성(mutability) 경계 — 프로젝트 CRITICAL immutability 규칙의 의도된 예외:
 *   - 라이브 가변: `RoomNode.occupants`(점유자 Set), `RoomNode.creatures`(라이브 크리처 배열 —
 *     스폰 push·사망 제거, occupants 선례), `CreatureInstance`의 라이브 상태 필드(hpcur·mpcur·
 *     타이머·enemies·inventory), `ExitEdge.flags`+`ExitEdge.ltime`(문 개폐/재잠금 상태 머신 — oracle a4 §111
 *     `check_exits`가 ltime+interval로 재잠금), `RoomNode.permMon[].ltime`(perm 리스폰 타이머 —
 *     exit ltime과 동형, 입장 lazy 리스폰·사망 시 now로 세팅. Story 4·5).
 *   - immutable: 정적 필드 전부 + `RoomNode.flags`(64비트 raw 방 flags는 콘텐츠로 불변) +
 *     `RoomNode.random`/`RoomNode.traffic`(스폰 정의 콘텐츠, 불변).
 *   방 flags와 exit flags를 혼동하지 않는다 — 전자는 불변, 후자는 문 상태로 가변이다.
 */

/**
 * 방 출구 엣지. 원본 raw exit의 `room`(대상 방 번호)을 `targetRoomId`로 매핑한다.
 *
 * `ltime`은 마지막 상태 변경 실초 시각(기본 0), `interval`은 재잠금/재닫힘 지연 초로
 * 둘 다 런타임 전용 필드다(raw에는 없음). oracle a4 §111 `check_exits`가
 * `ltime + interval < now`이면 `XLOCKS`/`XCLOSS` 출구를 자동 재잠금/재닫힘한다 —
 * `ltime`이 문 상태 머신의 타이밍을 인코딩한다. 대상이 그래프에 없으면(dangling)
 * 엣지는 그대로 유지되고 해석은 지연(Map.has 조회)된다.
 */
export type ExitEdge = {
  name: string
  targetRoomId: number
  flags: number[]
  key: number
  ltime: number
  interval: number
}

/**
 * 인메모리 바닥 아이템 인스턴스. `instanceId`는 부팅 시 생성되는 고유 id로 디스크에
 * 저장되지 않는다(non-durable). 컨테이너는 `contains`로 재귀 중첩된다.
 */
export type ItemInstance = {
  instanceId: string
  name: string
  description: string
  value: number
  /**
   * object flags(8바이트 hex string, creatures/objects.json과 동일 표현). scavenge(A9 §3.3) 제외
   * 판정에 쓰인다 — OPERMT·OHIDDN·OPERM2·ONOTAK·OSCENE 중 하나라도 있으면 몬스터가 줍지 못한다.
   * 콘텐츠(불변). 전투 스탯 등 나머지 object 필드는 아이템 에픽 소관이라 여기에 싣지 않는다(D8).
   */
  flags: string
  contains: ItemInstance[]
}

/**
 * 라이브 크리처 인스턴스 — 크리처 템플릿(또는 방 embedded 몬스터)을 부팅/스폰 시 물질화한
 * 런타임 객체. `instanceId`는 디스크에 저장되지 않는 고유 id다(non-durable, ItemInstance 선례).
 *
 * 두 출처(server `creatureFactory`):
 *   (a) 방 embedded 몬스터 — 방 파일에 박힌 완전한 creature 구조체(빌더 커스터마이즈).
 *       `templateId=null`(템플릿 링크 없음, 인라인 데이터로 물질화).
 *   (b) 템플릿 번호 — `creatures.json`을 id로 조회해 물질화(perm/random 스폰·MSUMMO 소환용).
 *       `templateId`=조회한 템플릿 id.
 *
 * 라이브 가변 필드(hpcur·mpcur·`nextActionAt`·`lastRegenAt`·enemies)는 tick/전투가 in-place
 * 변경한다(occupants 선례, immutability 규칙 승인 예외). `flags`는 creatures.json과 동일한
 * hex string 표현을 유지한다(콘텐츠, 불변). `enemies`는 적 characterId/instanceId seam으로
 * 부팅 시 빈 배열이며 E6 전투가 채운다.
 */
export type CreatureInstance = {
  instanceId: string
  templateId: number | null
  name: string
  level: number
  hpmax: number
  hpcur: number
  mpmax: number
  mpcur: number
  dexterity: number
  gold: number
  special: number
  /**
   * 전투 스탯(콘텐츠, 불변) — cross-topic creature-spawn 필드 확장(`enemies` 선례). 스펙 §3.2
   * monster operand 실현: E6 전투 해석이 armor(AC)·thaco(공격표)·ndice/sdice/pdice(피해 굴림
   * N d S + P)를 읽는다. 소스 JSON(creatures.json / rooms.json `monsters[]`, port templates.js
   * 오프셋 340/341/352/354/356)에 이미 존재하며 물질화 시점에 옮긴다 — embedded 몬스터는
   * `templateId=null`이라 재조회가 불가능하기 때문이다. armor·thaco는 부호 있는 정수 가능.
   */
  armor: number
  thaco: number
  ndice: number
  sdice: number
  pdice: number
  flags: string
  enemies: string[]
  /**
   * 크리처가 보유한 아이템(라이브 가변). 부팅 시 빈 배열이며 scavenge(A9 §3.3)가 바닥 아이템을
   * 여기로 옮긴다. Story 5 사망 시 바닥 드롭의 출처가 된다. embedded 몬스터의 초기 인벤토리
   * 물질화는 별도(아이템 에픽) 소관이라 여기선 scavenge 회수분만 담는다.
   */
  inventory: ItemInstance[]
  /** 다음 autonomic/전투 행동 도래 실초 시각. Story 3 next-action 큐가 세팅. */
  nextActionAt?: number
  /** 마지막 재생 적용 실초 시각(LT_HEALS 도래 기준). Story 3 재생이 소급 baseline으로 사용. */
  lastRegenAt?: number
  /** 마지막 scavenge 게이트 통과 실초 시각(LT_MSCAV). Story 3 scavenge 20초 게이트. */
  lastScavengeAt?: number
  /** 마지막 wander-out 게이트 통과 실초 시각(LT_MWAND). Story 3 wander-out 20초 게이트. */
  lastWanderAt?: number
  /**
   * 혼동(MBEFUD) 만료 실초 시각(LT_BEFUD 도래시각). E6 전투/주문이 미래 시각으로 세팅한다. 미설정은
   * "활성 혼동 없음"(오라클 LT_BEFUD=0=과거)이라, autonomic이 MBEFUD 비트를 스크럽한다 — 스폰 시 on-disk
   * MBEFUD stale 비트(예 화룡)를 첫 처리에서 정리한다(오라클 update.c:258 무가드). 능동 효과는 E6 소관.
   */
  befuddledUntil?: number
  /**
   * 매혹(MCHARM) 만료 실초 시각(LT_CHRMD 도래시각). E6 주문이 미래 시각으로 세팅한다. 미설정은 "활성 매혹
   * 없음"(LT_CHRMD=0=과거)이라 autonomic이 MCHARM을 스크럽한다 — 스폰 시 on-disk stale 비트(초향·모래괴물·
   * 해적)를 정리한다(오라클 update.c:277). 능동 효과는 E6 소관.
   */
  charmedUntil?: number
}

/**
 * perm 스폰 슬롯 — 방 구조체 `lasttime perm_mon[10]`의 런타임 표현. `misc`는 스폰할 몹번호,
 * `interval`은 리스폰 지연 초, `ltime`은 마지막 스폰/사망 실초 시각(라이브 가변 — exit ltime과
 * 동형). Story 4가 `ltime+interval ≤ now` 슬롯을 입장 시 lazy 리스폰하고, Story 5가 사망 시
 * `ltime = now`로 리셋한다.
 */
export type PermMonSlot = {
  interval: number
  ltime: number
  misc: number
}

/**
 * 방 그래프 노드. 그래프 탐색·표시에 필요한 필드만 담는다(모든 raw 필드를 옮기지 않음).
 * raw의 short_desc/long_desc를 shortDesc/longDesc로 매핑한다.
 *
 * `flags`는 64비트 raw 방 flags를 8바이트 number[]로 그대로 보존한다(oracle a4 §117 —
 * 이동/마법/상점/전투 서브시스템이 이 플래그를 읽으므로 방이 전부 운반해야 한다). 불변.
 * `occupants`는 방에 있는 캐릭터의 characterId 집합으로 라이브 가변이다. shared는
 * server의 ActorContext를 import할 수 없으므로 원소 타입은 string(characterId)이다.
 *
 * 스폰 필드: `creatures`는 방의 라이브 크리처 배열(가변 — 스폰 push·사망 제거), `permMon`은
 * perm 스폰 슬롯 배열(각 슬롯 ltime 가변), `random`은 랜덤 스폰 몹번호 후보(길이 10, 불변),
 * `traffic`은 스폰/배회 확률(불변).
 */
export type RoomNode = {
  roomId: number
  name: string
  shortDesc: string
  longDesc: string
  exits: ExitEdge[]
  items: ItemInstance[]
  flags: number[]
  occupants: Set<string>
  creatures: CreatureInstance[]
  permMon: PermMonSlot[]
  random: number[]
  traffic: number
}

/**
 * `getDirectionHints`의 반환 형태. 방 출구를 두 부류로 분리한다.
 *   - `cardinal`: 기본 6방향 출구(동/서/남/북/위/밑).
 *   - `other`: 그 외 전부 — 명명 출구(거실/문/밖 등)와 대각 출구(남서/북서/북동/남동).
 */
export type DirectionHints = {
  cardinal: ExitEdge[]
  other: ExitEdge[]
}

/** 기본 6방향 출구명 집합(oracle a3 §2-1 방향 매핑표: 동/서/남/북/위/밑). */
const CARDINAL_NAMES: ReadonlySet<string> = new Set(['동', '서', '남', '북', '위', '밑'])

/**
 * 방 출구를 기본 6방향(cardinal)과 명명/대각(other)으로 분류하는 파생 순수 함수.
 *
 * 노드 필드로 물질화하지 않는 on-demand 조회다 — 방향은 간선 라벨일 뿐이고 무한의
 * 월드에는 좌표(x/y/z)가 없으므로(oracle a4 §7) 좌표를 합성하지 않는다. 대각 출구
 * (남서 등)는 라이브에서 전체 단어 입력으로만 도달 가능한 별칭 없는 명명 출구이므로
 * (oracle a3 §2-2, numpad/jamo 대각 정규화는 죽은 코드) 기본 6축이 아니라 other로 둔다.
 * 밖(out)도 6방향 축이 아니므로 other다.
 *
 * 부수효과·전역 상태 없음. 입력 room을 변형하지 않고 새 배열을 반환한다.
 */
export function getDirectionHints(room: RoomNode): DirectionHints {
  const cardinal: ExitEdge[] = []
  const other: ExitEdge[] = []
  for (const exit of room.exits) {
    if (CARDINAL_NAMES.has(exit.name)) cardinal.push(exit)
    else other.push(exit)
  }
  return { cardinal, other }
}
