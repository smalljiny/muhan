import type { ExitEdge } from 'shared'

/**
 * 문·열쇠 상태머신 — 출구 플래그 조합으로 open/close/lock/unlock 전이를 구현하는 순수 로직.
 *
 * oracle `docs/notes/game-analysis-20260625/a4-movement-rooms.md` §2·§3 이식:
 *   문은 별도 엔티티가 아니라 출구의 플래그 조합이다. 상태 2비트(XCLOSD·XLOCKD)와
 *   능력 3비트(XCLOSS·XLOCKS·XUNPCK)로 상태머신을 이룬다(command6.c:365–722).
 *
 * 가변성(immutability) carve-out — 프로젝트 CRITICAL immutability 규칙의 의도된 예외:
 *   전이 함수는 라이브 문 상태(`exit.flags` 바이트 + `exit.ltime`)를 in-place로 변경한다.
 *   worldGraph 타입 주석(ExitEdge.flags+ltime은 라이브 가변)과 정합하는 설계다.
 *   그 외 어떤 입력도 변형하지 않는다(unlock의 key.shotscur 감소는 별도 carve-out, 해당 위치 주석 참조).
 *
 * 범위 경계: WS 명령 배선·인벤토리 조회·picklock(도둑 전용)은 호출자 seam이다.
 *   전이 함수는 문 상태(flags+ltime)만 변경하고, `now`(현재 실초)는 인자 주입 seam이다.
 */

// ── 출구 플래그 비트 상수 (oracle a4 §2, 오라클 검증 완료) ────────────────────
// 상태 2비트 + 능력 3비트. XNOSEE는 가시성+통행 게이트(§2)로 여기선 hasFlag 검증용.
/** 잠김(상태) — F_ISSET bit 2. */
export const XLOCKD = 2
/** 닫힘(상태) — F_ISSET bit 3. */
export const XCLOSD = 3
/** 잠글 수 있음(능력) — F_ISSET bit 4. */
export const XLOCKS = 4
/** 닫을 수 있음(능력) — F_ISSET bit 5. */
export const XCLOSS = 5
/** 자물쇠 못 땀(능력) — F_ISSET bit 6, picklock 확률 0. */
export const XUNPCK = 6
/** 못 봄/못 씀(가시성+통행) — F_ISSET bit 19. */
export const XNOSEE = 19

/** KEY 오브젝트 타입 값(oracle a8 §items). 열쇠는 obj.type===KEY로 식별. */
export const KEY = 11

/**
 * 열쇠 오브젝트의 door 로컬 최소 shape.
 *
 * 실 인벤토리/오브젝트 배선은 후속 토픽 소관이므로 shared ObjectInstance를 import하지 않고
 * (shotscur는 인스턴스·ndice는 템플릿이라 실 조회 seam이 아직 없음) 매칭·소모에 필요한
 * 최소 필드만 로컬 타입으로 둔다. 여기선 문 상태머신의 매칭 규칙만 다룬다.
 */
export type KeyLike = {
  /** 오브젝트 타입. KEY(11)여야 열쇠로 인정된다. */
  type: number
  /** 주사위 수 필드를 열쇠 ID로 전용(oracle §3). exit.key와 숫자로 대조한다. */
  ndice: number
  /** 잔여 사용 횟수. unlock 성공 시 1 감소한다(0이면 부서짐 — 그 처리는 호출자 seam). */
  shotscur: number
}

// ── 비트 연산 헬퍼 (원본 F_ISSET 이식) ───────────────────────────────────────

/**
 * 플래그 배열에서 지정 비트가 세팅됐는지 판정한다.
 *
 * 원본 `F_ISSET(p,f) = flags[f/8] & (1<<(f%8))`(mtype.h:566) 이식. flags는 바이트당
 * 한 원소(0–255)인 number[]다. 인덱스가 배열 범위 밖이면 `?? 0`으로 false를 반환한다(안전 가드).
 */
export function hasFlag(flags: number[], bit: number): boolean {
  const idx = Math.floor(bit / 8)
  return ((flags[idx] ?? 0) & (1 << (bit % 8))) !== 0
}

/**
 * 플래그 배열의 해당 비트를 세팅한다(in-place).
 *
 * carve-out: 라이브 문 상태 변경은 의도된 mutation 예외다. 전이 함수가 flags를 갱신한다.
 */
export function setFlag(flags: number[], bit: number): void {
  const idx = Math.floor(bit / 8)
  flags[idx] = (flags[idx] ?? 0) | (1 << (bit % 8))
}

/**
 * 플래그 배열의 해당 비트를 해제한다(in-place).
 *
 * carve-out: 라이브 문 상태 변경은 의도된 mutation 예외다. 전이 함수가 flags를 갱신한다.
 */
export function clearFlag(flags: number[], bit: number): void {
  const idx = Math.floor(bit / 8)
  flags[idx] = (flags[idx] ?? 0) & ~(1 << (bit % 8))
}

// ── 열쇠 매칭 predicate ──────────────────────────────────────────────────────

/**
 * 열쇠가 출구에 맞는지 판정한다 — 이름이 아니라 숫자 매칭.
 *
 * oracle §3: `obj->type == KEY && obj->ndice == exit->key`(command6.c:512,598).
 * shotscur 소모는 여기서 하지 않고 unlock 전이가 담당한다(순수 predicate 유지).
 */
export function keyMatch(obj: KeyLike, exit: ExitEdge): boolean {
  return obj.type === KEY && obj.ndice === exit.key
}

// ── 문 상태 전이 함수 ────────────────────────────────────────────────────────

/**
 * 문 열기. `XLOCKD`(잠김)면 거부, 아니면 `XCLOSD` 해제 + `ltime` 리셋 후 true.
 *
 * oracle §3: openexit는 XLOCKD면 거부, XCLOSD 해제, ltime.ltime=now(타이머 리셋).
 * 거부 경로는 부수효과 없이 false만 반환한다.
 */
export function openexit(exit: ExitEdge, now: number): boolean {
  if (hasFlag(exit.flags, XLOCKD)) return false
  clearFlag(exit.flags, XCLOSD)
  exit.ltime = now // 타이머 리셋 — 다음 재닫힘/재잠금 기준점
  return true
}

/**
 * 문 닫기. `XCLOSS`(닫을 수 있음) 능력이 없으면 거부, 있으면 `XCLOSD` 설정 후 true.
 *
 * oracle §3: closeexit는 XCLOSS 능력 필요, XCLOSD 설정. 타이머는 리셋하지 않는다.
 */
export function closeexit(exit: ExitEdge): boolean {
  if (!hasFlag(exit.flags, XCLOSS)) return false
  setFlag(exit.flags, XCLOSD)
  return true
}

/**
 * 문 잠그기. `XLOCKS`(잠글 수 있음) + `XCLOSD`(먼저 닫힘) + 열쇠 일치 전부 충족 시
 * `XLOCKD` 설정 후 true, 아니면 false.
 *
 * oracle §3: lock은 XLOCKS + XCLOSD + 열쇠 → XLOCKD 설정. 타이머 리셋 없음
 * (openexit/unlock만 리셋). 거부 경로는 부수효과 없이 false만 반환한다.
 */
export function lock(exit: ExitEdge, key: KeyLike): boolean {
  if (!hasFlag(exit.flags, XLOCKS)) return false
  if (!hasFlag(exit.flags, XCLOSD)) return false
  if (!keyMatch(key, exit)) return false
  setFlag(exit.flags, XLOCKD)
  return true
}

/**
 * 문 열쇠로 잠금 해제. `XLOCKD`(잠김) + 열쇠 일치 시 `XLOCKD` 해제 + `key.shotscur` 감소
 * + `ltime` 리셋 후 true, 아니면 false.
 *
 * oracle §3: unlock은 XLOCKD + 열쇠 → XLOCKD 해제, 열쇠 shotscur--, 타이머 리셋.
 * 거부 경로는 부수효과 없이 false만 반환한다. 열쇠 0 소진 시 파괴 처리는 호출자 seam.
 */
export function unlock(exit: ExitEdge, key: KeyLike, now: number): boolean {
  if (!hasFlag(exit.flags, XLOCKD)) return false
  if (!keyMatch(key, exit)) return false
  clearFlag(exit.flags, XLOCKD)
  // carve-out(별도): 열쇠 사용 횟수 소모는 flags/ltime과 구분되는 의도된 mutation이다.
  // 실 인벤토리 배선(0 소진 시 파괴)은 호출자 seam이고, 여기선 소모만 반영한다.
  key.shotscur -= 1
  exit.ltime = now // 타이머 리셋
  return true
}
