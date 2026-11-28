import type { CombatRng } from '../combat/dice.js'

/**
 * 스크립트 전투 굴림 — 통합 테스트가 `vi.mock('../combat/dice.js', ...)`로 `defaultCombatRng` 자리에
 * 꽂는 결정적 굴림 큐(test-only).
 *
 * `createLiveWorldWiring`은 굴림 seam을 `defaultCombatRng`로 하드코딩한다(D4 — 묶음에 rng seam을 뚫지
 * 않는다). 그래서 프로덕션 조립 경로를 그대로 두고 모듈 export만 이 큐로 바꾼다. 몬스터 tick과 오프너
 * 공격 핸들러가 모두 같은 export를 캡처하므로 두 경로의 굴림이 한 큐에서 순서대로 나간다.
 *
 * 계약:
 * - 큐가 비었는데 굴림이 오면 throw한다 — 시나리오 굴림 예산을 넘는 소비를 즉시 드러낸다.
 * - 꺼낸 값이 그 굴림의 `[min, max]` 밖이면 throw한다 — 예산 순서가 어긋나(예: 명중 굴림 자리에 피해
 *   값이 들어감) 우연히 통과하는 일을 막는다.
 * - `remaining()`으로 잔여 0을 단언해 예산보다 적게 소비한 경우도 잡는다.
 *
 * mock factory가 동적 import로 이 모듈을 읽고 테스트 파일도 같은 모듈을 import하므로, 두 쪽이 같은
 * 싱글턴 인스턴스를 본다. 이 파일은 `dice.js`를 타입으로만 참조해 mock 대상 모듈을 실제로 끌어오지 않는다.
 */
export interface CombatRngScript {
  /** `defaultCombatRng` 자리에 꽂히는 굴림 함수. */
  readonly rng: CombatRng
  /** 다음 시나리오 굴림 값을 순서대로 적재한다(이전 잔여는 버린다). */
  load(values: readonly number[]): void
  /** 아직 소비되지 않은 굴림 수. */
  remaining(): number
  /** 지금까지 소비된 굴림의 `[min, max, value]` 기록(실패 진단용). */
  consumed(): ReadonlyArray<readonly [number, number, number]>
  /** 큐와 기록을 비운다. */
  reset(): void
}

function createCombatRngScript(): CombatRngScript {
  let queue: number[] = []
  let log: Array<readonly [number, number, number]> = []

  const rng: CombatRng = (min, max) => {
    const value = queue.shift()
    if (value === undefined) {
      throw new Error(`스크립트 굴림 소진: rng(${min}, ${max}) — 시나리오 굴림 예산 초과`)
    }
    if (value < min || value > max) {
      throw new Error(`스크립트 굴림 값 ${value}이 rng(${min}, ${max}) 범위 밖 — 예산 순서 어긋남`)
    }
    log.push([min, max, value])
    return value
  }

  return {
    rng,
    load(values) {
      queue = [...values]
      log = []
    },
    remaining: () => queue.length,
    consumed: () => log,
    reset() {
      queue = []
      log = []
    },
  }
}

/** 프로세스(테스트 파일) 단위 싱글턴 — mock factory와 테스트 본문이 같은 인스턴스를 공유한다. */
export const combatRngScript: CombatRngScript = createCombatRngScript()
