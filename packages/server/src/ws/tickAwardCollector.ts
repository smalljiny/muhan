/**
 * tick 범위 경험치 수령자 수집기 (스펙 §3.4 "경험치 수령자 수집", D11).
 *
 * 사망 seam 관찰자(`onCreatureDeathAwards`)는 오프너(`ws/handlers/attack.ts`)와 combatTick이 **같은
 * 인스턴스**를 쓴다. 그래서 수집을 combatTick 호출 하나에 묶는다 — wiring의 래퍼가 호출 시작에
 * `begin()`, `finally`에서 `end()`를 부르고, 수집기는 켜져 있을 때만 기록한다. 오프너 처치에서 실행된
 * 관찰자 호출은 수집기가 꺼져 있어 아무것도 남기지 않는다(그 통지는 공격 핸들러 반환이 맡는다).
 *
 * - `begin()`: 잔여를 비우고 켠다. `end()`가 빠진 이전 호출이 있어도 이전 수령자가 새지 않는다.
 * - `end()`: 끄고 비운다 — 이후 `current()`는 빈 집합.
 * - `record(ids)`: 켜져 있을 때만 누적한다(범위 밖이면 무시). 인자 배열은 읽기만 한다.
 * - `current()`: 이번 tick 호출의 수령자 집합을 **복사 없이** 읽기 전용 뷰로 돌려준다. 통지기가
 *   `onRoundResolved` 콜백 안에서만 읽고 참조를 보관하지 말 것 — `begin()`·`end()`가 같은 집합을 비운다.
 */
export interface TickAwardCollector {
  begin(): void
  end(): void
  record(ids: readonly string[]): void
  current(): ReadonlySet<string>
}

export function createTickAwardCollector(): TickAwardCollector {
  let active = false
  const awarded = new Set<string>()
  return {
    begin() {
      awarded.clear()
      active = true
    },
    end() {
      active = false
      awarded.clear()
    },
    record(ids) {
      if (!active) return
      for (const id of ids) awarded.add(id)
    },
    current() {
      return awarded
    },
  }
}
