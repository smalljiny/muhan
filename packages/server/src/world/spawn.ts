import { loadWorldFile } from 'shared'
import type { CreatureInstance, RoomNode } from 'shared'
import { fromTemplate, defaultCreatureRng, type CreatureRng, type CreatureSource } from './creatureFactory.js'
import { F_ISSET, F_SET, MPERMT } from './hexFlags.js'

/**
 * 스폰 공통 인프라 + perm 입장 lazy 리스폰(플랜 T4.1, A9 §2.1 add_permcrt_rom room.c:308).
 *
 * 세 스폰 트리거(perm·random·invasion)가 공유하는 두 seam을 여기서 정의한다:
 *   1. `SpawnTemplateIndex` — 몹번호로 크리처 템플릿을 조회하는 인덱스(팩토리 (b)의 입력).
 *      random 그룹 크기 산정에 `numwander`(D9)가 필요하므로 `CreatureSource`에 numwander를 더한
 *      `SpawnTemplate`을 값으로 담는다. `numwander`는 스폰 그룹 크기 입력이라 `CreatureInstance`에는
 *      싣지 않고 여기 raw 템플릿 인덱스에만 둔다.
 *   2. `InstanceIdAllocator` — 방별 monotonic idx 발급기(D7). 리스폰·스폰·소환이 새 인스턴스 idx를
 *      배열 길이/인덱스에서 파생하면 사망 후 충돌하므로(예 `[c0,c1,c2]`→c1 사망→`[c0,c2]`→다음 스폰 c2
 *      충돌), 방별 단조 카운터로 발급한다.
 *
 * perm 리스폰은 스케줄러가 아니라 입장 시점 lazy 재계산이다(빈 방 미리젠 없음) — onRoomEntered
 * (Story 2 seam)에서 호출되며 조립 배선은 Story 6이 소유한다. `room.creatures` push는 라이브 가변
 * carve-out(worldGraph 타입 주석과 정합)이다.
 */

/** 스폰 템플릿 = 크리처 소스 + numwander(random 그룹 크기 입력, D9). */
export type SpawnTemplate = CreatureSource & { readonly numwander: number }

/** 몹번호 → 스폰 템플릿 인덱스. fromTemplate에도 그대로 넘길 수 있다(SpawnTemplate <: CreatureSource). */
export type SpawnTemplateIndex = ReadonlyMap<number, SpawnTemplate>

/** creatures.json raw 엔트리(스폰에 필요한 필드만). */
type RawCreatureTemplate = SpawnTemplate & { readonly id: number }

/** raw creatures 배열을 몹번호 인덱스로 만든다. 필요한 필드만 복사해 raw 번들과 분리한다. */
export function buildSpawnTemplateIndex(raw: readonly RawCreatureTemplate[]): SpawnTemplateIndex {
  const map = new Map<number, SpawnTemplate>()
  for (const c of raw) {
    map.set(c.id, {
      name: c.name,
      level: c.level,
      hpmax: c.hpmax,
      mpmax: c.mpmax,
      dexterity: c.dexterity,
      gold: c.gold,
      special: c.special,
      // 전투 스탯(D6) — creatures.json 소스에서 그대로 옮긴다(fromTemplate 물질화가 인스턴스로 전파).
      armor: c.armor,
      thaco: c.thaco,
      ndice: c.ndice,
      sdice: c.sdice,
      pdice: c.pdice,
      // 마법 읽기 필드(Story 2) — creatures.json 소스에서 그대로 옮긴다(fromTemplate 물질화가 인스턴스로
      // 전파). realm은 소스에 없어 materialize가 [0,0,0,0] 기본값을 채운다.
      spells: c.spells,
      class: c.class,
      intelligence: c.intelligence,
      piety: c.piety,
      // 사망 분배 읽기 필드(Story 6) — creatures.json 소스에서 그대로 옮긴다. 명시 매핑이므로
      // 여기서 누락하면 fromTemplate 물질화가 undefined를 실어 Story 7 분배가 값을 못 읽는다.
      experience: c.experience,
      alignment: c.alignment,
      // 이름 매칭용 별칭(Story 4) — creatures.json 소스에서 옮긴다. keys는 선택 필드라 여기서
      // 누락해도 컴파일이 통과하므로, 템플릿 스폰 경로 회귀 테스트가 유일한 방어선이다.
      // 배열은 복사한다 — 이 인덱스는 폐기될 raw 번들과 분리한다는 위 계약을 따른다.
      keys: [...(c.keys ?? [])],
      flags: c.flags,
      numwander: c.numwander,
    })
  }
  return map
}

/** 부팅 시 creatures.json을 읽어 스폰 템플릿 인덱스를 만든다(조립 지점 seam). */
export function loadSpawnTemplates(worldRoot?: string): SpawnTemplateIndex {
  const raw = loadWorldFile<RawCreatureTemplate[]>('creatures.json', worldRoot)
  return buildSpawnTemplateIndex(raw)
}

/** 방별 monotonic 인스턴스 idx 발급기(D7). 전역 금지 — 조립 지점이 단일 인스턴스를 주입·공유한다. */
export interface InstanceIdAllocator {
  /** 방에 대해 다음 idx를 발급한다(단조 증가, 사망·제거와 무관). */
  next(room: RoomNode): number
}

/**
 * monotonic idx 발급기를 만든다. `rooms`가 주어지면 각 방의 seed를 **pristine** `creatures.length`
 * (초기 embedded 개수)로 고정한다 — 조립 지점이 loadWorldGraph 직후(어떤 tick·제거도 일어나기 전)
 * 전 방을 seed하면 이후 어떤 사망·wander로 배열이 줄어도 카운터는 단조 증가만 하므로 idx가 충돌하지
 * 않는다(D7). seed 안 된 방은 첫 발급 시 그 시점의 length로 lazy fallback한다(방어적, 조립 지점은
 * upfront seed로 이 경로를 쓰지 않는다).
 */
export function createInstanceIdAllocator(rooms?: Iterable<RoomNode>): InstanceIdAllocator {
  const seq = new Map<number, number>()
  if (rooms !== undefined) {
    for (const room of rooms) seq.set(room.roomId, room.creatures.length)
  }
  return {
    next(room) {
      const n = seq.get(room.roomId) ?? room.creatures.length
      seq.set(room.roomId, n + 1)
      return n
    },
  }
}

/** perm 리스폰 의존성(전역 금지 — 인자 주입). */
export interface PermRespawnDeps {
  /** 몹번호 → 템플릿 인덱스(팩토리 (b) 조회). */
  readonly templates: SpawnTemplateIndex
  /** 방별 monotonic idx 발급기(D7). */
  readonly alloc: InstanceIdAllocator
  /** carry/gold 랜덤화 seam(기본 결정적 identity). */
  readonly rng?: CreatureRng
}

/**
 * 방 입장 시 `permMon[]`을 검사해 due 슬롯을 재스폰한다(A9 §2.1 add_permcrt_rom 이식).
 *
 * 원본 room.c:308 알고리즘 충실:
 *   - checklist로 같은 misc 중복 처리를 방지한다.
 *   - due 판정: `ltime + interval > now`면 스킵(리스폰 대기). 즉 due = `≤ now`.
 *   - 같은 misc의 뒤 슬롯 중 `ltime + interval < now`인 것을 합산해 총 스폰 수 n을 얻는다
 *     (원본의 바깥 `> t`·안쪽 `< t` 경계 비대칭까지 재현).
 *   - 방 내 살아있는 동명 MPERMT 수 m을 세어 n − m마리만 스폰한다(중복 방지).
 *   - 각 스폰: 팩토리 (b) 물질화 → MPERMT 세팅 → room.creatures push. idx는 monotonic 발급기(D7).
 *
 * ltime은 여기서 쓰지 않는다(읽기만) — 사망 시 `ltime = now` 리셋은 Story 5(onCreatureDeath) 소관.
 * 스폰된 크리처 배열을 반환한다(테스트·조립 지점 관찰용).
 */
export function respawnPermCreatures(room: RoomNode, now: number, deps: PermRespawnDeps): CreatureInstance[] {
  const rng = deps.rng ?? defaultCreatureRng
  const slots = room.permMon
  const checklist = new Array<boolean>(slots.length).fill(false)
  const spawned: CreatureInstance[] = []

  for (let i = 0; i < slots.length; i++) {
    if (checklist[i]) continue
    const slot = slots[i]
    if (slot === undefined || slot.misc === 0) continue // 빈 슬롯
    if (slot.ltime + slot.interval > now) continue // 리스폰 대기 중(due = ≤ now)

    // 같은 misc의 뒤 슬롯 중 due인 것을 합산(원본 안쪽 루프는 `< t` 엄격 비교).
    let n = 1
    for (let j = i + 1; j < slots.length; j++) {
      const other = slots[j]
      if (other !== undefined && other.misc === slot.misc && other.ltime + other.interval < now) {
        n += 1
        checklist[j] = true
      }
    }

    const template = deps.templates.get(slot.misc)
    if (template === undefined) continue // load_crt < 0

    // 방 내 살아있는 동명 MPERMT 수(m). n − m마리만 스폰한다.
    let m = 0
    for (const c of room.creatures) {
      if (F_ISSET(c.flags, MPERMT) && c.name === template.name) m += 1
    }

    for (let k = 0; k < n - m; k += 1) {
      const idx = deps.alloc.next(room)
      const creature = fromTemplate(slot.misc, room.roomId, idx, rng, deps.templates)
      if (creature === undefined) continue
      creature.flags = F_SET(creature.flags, MPERMT)
      room.creatures.push(creature)
      spawned.push(creature)
    }
  }

  return spawned
}
