/**
 * 게임시각 진행 슬롯 — WorldClock에 얹혀 게임 내 시각(시간 단위)을 굴리는 첫 실 슬롯.
 *
 * 원본 충실: update.c:717 update_time. 원본은 150 실초마다 호출되어 전역 `Time`을 1 올리고
 * `daytime = Time % 24`를 계산한다(6시 아침·20시 밤 방송 포함). 본 이식은 케이던스(150초마다
 * Time++)와 시각 조회(Time % 24)만 재현하며, 6시/20시 경계 방송은 이번 범위에서 구현하지 않는다
 * (후속 이월). WorldClock이 1Hz 단조 tick 위에서 tickSec % 150 === 0인 틱에만 슬롯의 run을
 * 호출하므로, run 1회 발화 = 게임시각 1시간 경과다.
 *
 * 상태 캡슐화: 게임시각 상태 `Time`은 전역 변수가 아니라 팩토리 클로저에 가둔다. currentHour는
 * 스냅샷이 아니라 라이브 클로저 `time`을 읽어야 발화 후 변화를 반영한다.
 */

import type { WorldTickSlot } from './worldClock.js'

/** createGameTime 옵션. */
export interface GameTimeOptions {
  /** 시작 게임시각(시간 단위 누적값). 기본 0. */
  readonly initialTime?: number
}

/** 게임시각 슬롯과 조회 seam 묶음. slot은 WorldClock.register로 등록한다. */
export interface GameTime {
  /** WorldClock에 등록할 진행 슬롯(intervalSec=150, 발화당 Time += 1). */
  readonly slot: WorldTickSlot
  /** 현재 게임시각 시(0~23) = Time % 24. 라이브 클로저 상태를 읽는다. */
  readonly currentHour: () => number
}

/** 게임시각 슬롯 케이던스(실초). 원본 update_time 150초 주기 미러. */
const GAME_TIME_INTERVAL_SEC = 150

/**
 * 게임시각 진행 슬롯을 생성한다. 상태 `Time`은 이 팩토리 클로저에 캡슐화한 가변 변수다
 * (프로젝트 immutability 원칙의 의도된 carve-out — 문 상태와 동형. 게임 월드의 단조 진행
 * 상태라 매 발화마다 새 객체로 대체하는 대신 클로저 안에서 직접 증가시킨다).
 */
export function createGameTime(options: GameTimeOptions = {}): GameTime {
  // 캡슐화된 가변 상태(carve-out): WorldClock 슬롯 발화마다 1씩 증가하는 누적 게임시각.
  let time = options.initialTime ?? 0

  const slot: WorldTickSlot = {
    name: 'gameTime',
    intervalSec: GAME_TIME_INTERVAL_SEC,
    run(): void {
      time += 1
    },
  }

  return {
    slot,
    // ((x % 24) + 24) % 24로 정규화해 initialTime이 음수로 주입돼도 0~23 계약이 성립한다
    // (도메인상 Time은 0에서 단조 증가라 음수가 나오지 않지만, 계약을 입력과 무관하게 고정).
    // arrow 프로퍼티로 정의해 구조분해 시 this 바인딩 이슈가 없다.
    currentHour: (): number => ((time % 24) + 24) % 24,
  }
}
