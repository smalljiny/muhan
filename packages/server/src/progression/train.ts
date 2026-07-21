import {
  neededExp,
  upLevel,
  classifyPrestige,
  invinciblePrestige,
  caretakerPrestige,
  type Character,
} from 'shared'
import { hasFlag } from '../world/door.js'

/**
 * progression/train — `연마` 명령 핸들러. 3게이트 판정(location→exp→gold) → prestige 우선
 * 분기 → gold 차감 배치 upLevel(D6)을 결정적 순수 로직으로 옮긴다.
 *
 * 원본 `command7.c:530-650`(train 명령)의 progression 소관을 이식한다. shared 순수 함수
 * (neededExp·upLevel·classifyPrestige·invinciblePrestige·caretakerPrestige)를 소비하고, room
 * flag는 `hasFlag`(F_ISSET 이식), 영속화는 `markDirty` seam을 주입 소비한다. class·level·
 * experience·vitals 전이는 shared가 소유하고, train은 3게이트·gold 차감·배치 시퀀싱만 소유한다.
 *
 * ## immutability
 * 입력 char/room을 변형하지 않는다. 성공 시 새 Character를 반환하고, markDirty에는 그 시점
 * 스냅샷(distinct 참조)을 넘긴다(dirtyTracker 계약).
 *
 * ## gold 쓰기경로 조정 — named deferred dependency (미해결)
 * train은 성공 시 최종 Character 스냅샷(gold 포함)을 markDirty로 write-behind에 흘린다. 같은
 * characters 문서가 bank 트랜잭션 경로(bankTransactionService)로도 gold를 직접 쓰면, 커밋 이후
 * 도착한 train 스냅샷 flush가 gold를 되돌릴 수 있다(무성 revert). 이는 bankTransactionService
 * 상단 "쓰기 경로 조정 계약"과 동형 문제(X1/X2/X3 조정 패턴)이며, 이 스토리에서는 해결하지
 * 않는다 — train은 seam 소비자이고 라이브 command dispatcher 미배선이라 두 경로 충돌에 도달
 * 불가하다. 게임플레이 호출처 배선 토픽에서 두 경로를 조정한다.
 */

/**
 * 베이스 훈련방 플래그 비트(mtype.h:307 RTRAIN=3). class-bit 서브매칭은 RTRAIN+3-i(역순,
 * i=0→bit6·i=1→bit5·i=2→bit4)로 대조한다. help/rflags의 4는 off-by-one이라 무시한다.
 */
export const RTRAIN = 3

/** INVINCIBLE(무적) class 인덱스(mtype.h 정본). class>8 판정 경계. */
const INVINCIBLE = 9

/** CARETAKER(초인) class 인덱스. 초인은 수련 금지(command7.c:530). */
const CARETAKER = 10

/** normal(class<9) 레벨 상한 — 배치 루프가 정확히 이 레벨에서 정지한다. */
const NORMAL_LEVEL_CAP = 100

/** 영속화 대상 컬렉션명. */
const CHARACTERS_COLLECTION = 'characters'

/** train 성공/거부를 구별하는 Result. 거부는 사유를, 성공은 새 Character·상승폭·승급을 담는다. */
export type TrainResult =
  | {
      ok: false
      reason:
        | 'not-training-room'
        | 'class-mismatch'
        | 'caretaker-forbidden'
        | 'insufficient-exp'
        | 'insufficient-gold'
    }
  | {
      ok: true
      character: Character
      levelsGained: number
      prestige: 'invincible' | 'caretaker' | 'none'
    }

/** train이 소비하는 영속화 seam. 성공 경로에서만 스냅샷을 1회 전달한다. */
export type TrainDeps = {
  markDirty: (collection: string, id: string, snapshot: unknown) => void
}

/**
 * location gate — 초인 금지 → base RTRAIN → class-bit 역순 매칭(class>8 서브매칭 면제).
 *
 * oracle command7.c:530-585. base RTRAIN은 무적(class>8)도 필수다 — class>8의 fail=0은
 * class-bit 서브매칭만 면제하고 base 검사는 통과해야 한다. class 비트는 (class-1)의 하위 3비트,
 * 방 비트는 RTRAIN+3-i(역순). 각 i에서 불일치면 mismatch.
 */
function checkLocation(
  char: Character,
  room: { flags: number[] },
): 'not-training-room' | 'class-mismatch' | 'caretaker-forbidden' | null {
  if (char.class === CARETAKER) return 'caretaker-forbidden'
  if (!hasFlag(room.flags, RTRAIN)) return 'not-training-room'
  if (char.class >= INVINCIBLE) return null // 무적: class-bit 서브매칭 면제(base RTRAIN는 위에서 통과)
  const idx = char.class - 1
  for (let i = 0; i < 3; i++) {
    const classBit = (idx & (1 << i)) !== 0
    const roomBit = hasFlag(room.flags, RTRAIN + 3 - i)
    if (classBit !== roomBit) return 'class-mismatch'
  }
  return null
}

/**
 * `연마` 명령을 처리한다 — 3게이트 판정 → prestige 우선 분기 → gold 차감 배치 upLevel.
 *
 * 성공 시 새 Character를 반환하고 markDirty로 스냅샷을 1회 기록한다. 입력 char/room은 무변이.
 *
 * ## 오라클 상태 guard 미구현 (전체 생략, regen/death 유예 클래스 동형)
 * 오라클 train(command7.c:551-565)은 PBLIND(장님 → 수련 불가)·PUPDMG(버프 해제·hp/mp/주사위 조정)
 * guard를 가진다. 본 이식은 두 guard를 통째로 생략한다 — characterSchema에 상태 플래그 필드가 없어
 * 구현할 입력이 없다(regen의 RPHARM/ill/PPOISN·death의 DoT와 동일 유예). 상태 플래그가 스키마에
 * 붙는 후속 토픽에서 함께 이식한다.
 */
export function train(char: Character, room: { flags: number[] }, deps: TrainDeps): TrainResult {
  // ── Gate 1: location ──────────────────────────────────────────────────────
  const locationReject = checkLocation(char, room)
  if (locationReject !== null) return { ok: false, reason: locationReject }

  // ── Gate 2·3: exp·gold ────────────────────────────────────────────────────
  // goldneeded = (expneeded/10)/2 = trunc(expneeded/20) (중첩 floor 항등, command7.c:591).
  // 오라클 L≥128 gold clamp(goldneeded=5,000,000, command7.c:597-598)는 미구현 — 플랜 T6.3의
  // 균일 neededExp/20 단순화. 도달 조건은 무적(class9) 배치가 127 초과 상승하는 endgame 경로뿐이다.
  const expNeeded = neededExp(char.level)
  const goldNeeded = Math.trunc(expNeeded / 20)
  if (char.experience < expNeeded) return { ok: false, reason: 'insufficient-exp' }
  if (char.gold < goldNeeded) return { ok: false, reason: 'insufficient-gold' }

  // ── prestige 우선 분기 (train 진입 시 1회 평가, oracle prestige if는 do-while 앞) ────
  const prestige = classifyPrestige(char)
  if (prestige !== 'none') {
    const paid = { ...char, gold: char.gold - goldNeeded }
    const promote = prestige === 'invincible' ? invinciblePrestige : caretakerPrestige
    return finalize(promote(paid), 0, prestige, deps)
  }

  // ── 배치 do-while 루프 (none 경로) ────────────────────────────────────────
  // experience는 배치 중 불변(train은 exp를 안 깎음 — 레벨만 오르고 임계가 올라가 결국 종료).
  // gold만 차감. upLevel은 char를 spread하므로 gold를 별도 추적해 최종에 덮어쓴다.
  let current = char
  let gold = char.gold
  let expNeed = expNeeded
  let goldNeed = goldNeeded
  let levelsGained = 0
  do {
    // normal(class<9)만 L100서 정지(루프 본문 최상단 → 정확히 100서 종료, 초과 안 함).
    // 무적(class9)은 여기 안 걸림 → exp/gold 소진까지 상승(caretaker는 다음 train).
    if (current.level === NORMAL_LEVEL_CAP && current.class < INVINCIBLE) break
    gold -= goldNeed
    current = upLevel(current)
    levelsGained += 1
    expNeed = neededExp(current.level)
    goldNeed = Math.trunc(expNeed / 20)
  } while (expNeed <= current.experience && goldNeed <= gold)

  return finalize({ ...current, gold }, levelsGained, 'none', deps)
}

/**
 * 성공 결과를 조립한다 — markDirty에 스냅샷(distinct 참조)을 1회 기록하고 Result를 반환한다.
 * 반환 character와 스냅샷을 분리해, 반환값 이후 변이가 스냅샷에 전파되지 않게 한다(dirtyTracker 계약).
 */
function finalize(
  character: Character,
  levelsGained: number,
  prestige: 'invincible' | 'caretaker' | 'none',
  deps: TrainDeps,
): TrainResult {
  deps.markDirty(CHARACTERS_COLLECTION, character._id, { ...character })
  return { ok: true, character, levelsGained, prestige }
}
