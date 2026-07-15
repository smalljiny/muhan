import type { CreatureInstance, RoomNode } from 'shared'
import { fromTemplate, defaultCreatureRng, type CreatureRng } from './creatureFactory.js'
import { scheduleNextAction } from './nextAction.js'
import { F_ISSET, MPERMT, MSUMMO } from './hexFlags.js'
import type { SpawnTemplateIndex, InstanceIdAllocator } from './spawn.js'

/**
 * 사망 라이프사이클 seam(플랜 G5·Story 5). E6 전투가 HP<1을 판정한 뒤 호출하는 진입점을 **정의만**
 * 한다 — E4-2에서는 전투 코드가 없어 어떤 호출부도 이 함수를 부르지 않는다(test-driven). Story 6·index.ts
 * 배선 대상도 아니다(전투는 E6). 여기서 소유하는 사망 처리 3단계:
 *   1. perm 리스폰 타이머 리셋(die_perm_crt, creature.c:553) — MPERMT 크리처 사망 시 방 permMon[]에서
 *      동명·cooldown 미경과 슬롯의 ltime을 사망 시각으로 재시작한다.
 *   2. MSUMMO 소환(summon_crt, creature.c:821) — 사망 크리처의 special 몹번호로 부하 1마리를 소환한다.
 *   3. 제거 — 죽은 크리처를 방 creatures[]에서 splice한다(활성 시뮬레이션 이탈).
 *
 * ── special 3도메인 분리 (플랜 T5.3, A11 §5) ──────────────────────────────────
 * 원본에서 `special` 필드는 세 구조체가 각기 다른 의미로 재사용한다. 무한에는 범용 스크립팅 엔진이
 * 없으므로(A11) 이들을 하나의 "핸들러 레지스트리" 추상으로 통합하지 않는다 — 세 개의 독립 개념 seam이다:
 *   (1) creature.special = MSUMMO 사망 소환 몹번호 → **이 모듈의 onDeathSummon이 유일하게 구현**.
 *   (2) room.special     = 접근 게이트(가문 RONFML·결혼 RONMAR 진입 조건) → E5/E7 소관, 여기 미구현.
 *   (3) object.special   = 명령 디스패치(읽어/눌러/사용) → 명령 에픽 소관, 여기 미구현.
 * (2)·(3)은 별개 에픽이 각자의 dispatch point에서 소유한다. 이 모듈은 (1)만 안다.
 *
 * in-place 변형(permMon[i].ltime·room.creatures splice/push)은 tick 계층 carve-out 관례를 따른다
 * (creatureTick.applyResult·respawnPermCreatures 선례). `now`는 명시 인자로 받는다(Date.now 금지,
 * respawnPermCreatures(room, now, deps) signature 미러).
 */

/** 사망 처리 의존성(전역 금지 — 인자 주입). */
export interface CreatureDeathDeps {
  /** 몹번호 → 템플릿 인덱스. perm 이름 매칭(slot.misc→name)과 소환(special 조회)에 쓰인다. */
  readonly templates: SpawnTemplateIndex
  /** 방별 monotonic idx 발급기(D7) — 소환 크리처 instanceId 발급. */
  readonly alloc: InstanceIdAllocator
  /** carry/gold 랜덤화 seam(기본 결정적 identity) — 소환 크리처 loot. */
  readonly rng?: CreatureRng
}

/**
 * MSUMMO 소환(summon_crt, creature.c:821) — 사망 크리처가 MSUMMO면 `special` 몹번호로 부하 1마리를
 * 소환한다. total=1(원본 1마리). special=0이거나 템플릿이 없으면 소환하지 않는다.
 *
 * 타이머 초기화는 random 스폰(update.c:154)과 동일하게 소환 시각 now 기준이다 — nextActionAt=now+cadence,
 * scavenge/wander 게이트=now. idx는 방별 monotonic 발급기(D7).
 *
 * 죽인 플레이어 적 등록(add_enm_crt)은 전투 어그로라 E6 seam이다 — 여기서는 소환만 하고 적 리스트를
 * 채우지 않는다(enemies는 팩토리가 빈 배열로 초기화).
 *
 * 소환된 크리처 배열을 반환한다(0 또는 1마리, 테스트·조립 지점 관찰용).
 */
export function onDeathSummon(
  dead: CreatureInstance,
  room: RoomNode,
  now: number,
  deps: CreatureDeathDeps,
): CreatureInstance[] {
  if (!F_ISSET(dead.flags, MSUMMO)) return []
  if (dead.special === 0) return [] // 소환 대상 미지정

  const rng = deps.rng ?? defaultCreatureRng
  const idx = deps.alloc.next(room)
  const summoned = fromTemplate(dead.special, room.roomId, idx, rng, deps.templates)
  if (summoned === undefined) return [] // load_crt < 0(알 수 없는 몹번호)

  // 소환 시각 기준 타이머 초기화(원본 summon_crt — LT_ATTCK/MSCAV/MWAND.ltime = t).
  scheduleNextAction(summoned, now) // nextActionAt = now + cadence(dex)
  summoned.lastScavengeAt = now
  summoned.lastWanderAt = now
  room.creatures.push(summoned)
  return [summoned]
}

/**
 * perm 리스폰 타이머 리셋(die_perm_crt, creature.c:553) — 사망 크리처가 MPERMT면 방 permMon[]을 순회해
 * 동명 슬롯의 ltime을 사망 시각(now)으로 리셋한다. 이후 interval이 지나야 입장 시 재스폰된다.
 *
 * 원본 충실:
 *   - misc 0(빈 슬롯) 스킵.
 *   - `ltime + interval > now`(아직 cooldown 중) 슬롯 스킵.
 *   - slot.misc → 템플릿 조회 → `template.name === dead.name`이면 ltime=now 세팅 후 break(첫 매칭만).
 *
 * 이름 매칭 필수: embedded MPERMT 크리처는 templateId=null이라 templateId로 슬롯을 못 찾는다. 슬롯의
 * misc 몹번호로 템플릿 이름을 조회해 사망 크리처 이름과 대조한다(respawnPermCreatures 동일 패턴).
 */
function resetPermRespawnTimer(dead: CreatureInstance, room: RoomNode, now: number, templates: SpawnTemplateIndex): void {
  if (!F_ISSET(dead.flags, MPERMT)) return

  const slots = room.permMon
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]
    if (slot === undefined || slot.misc === 0) continue // 빈 슬롯
    if (slot.ltime + slot.interval > now) continue // 아직 cooldown 중

    const template = templates.get(slot.misc)
    if (template === undefined) continue // load_crt < 0

    if (template.name === dead.name) {
      slot.ltime = now // 리스폰 타이머를 사망 시각부터 재시작(라이브 가변 carve-out).
      break
    }
  }
}

/**
 * 사망 처리 진입점 — perm 리셋 → MSUMMO 소환 → 방 creatures[] 제거 순으로 처리한다(die_perm_crt 시퀀스).
 *
 * 제거는 방 creatures[] splice로 충분하다 — activeSet은 방 단위(occupants 구동) 컬렉션이라 개별 크리처
 * 멤버십이 없다. 방 배열에서 빠지면 creatureTick이 순회하지 않아 활성 시뮬레이션에서 이탈한다(wander-out
 * applyResult "활성집합은 방 단위라 별도 처리 불요" 선례와 정합). 참조 미존재(이미 제거)여도 안전하다.
 */
export function onCreatureDeath(
  dead: CreatureInstance,
  room: RoomNode,
  now: number,
  deps: CreatureDeathDeps,
): void {
  // 1. perm 리스폰 타이머 리셋(MPERMT).
  resetPermRespawnTimer(dead, room, now, deps.templates)

  // 2. MSUMMO 소환(부하 1마리).
  onDeathSummon(dead, room, now, deps)

  // 3. 제거 — 죽은 크리처를 방 creatures[]에서 splice(참조 기반, 소환 push와 무관).
  const idx = room.creatures.indexOf(dead)
  if (idx >= 0) room.creatures.splice(idx, 1)
}
