import type { OnCombatTick } from './creatureTick.js'

/**
 * 전투 tick 지연 바인딩 슬롯 — world 레이어가 전투 레이어(combat 디렉토리)를 import하지 않고도
 * 나중에 조립된 전투 핸들러로 `onCombatTick`을 위임하게 한다.
 *
 * ## 왜 지연 바인딩인가
 * `createWorldRuntime`(creatureTick 포함)은 boot 시점에 만들어지지만, 실 전투 핸들러는 세션·송신
 * 계층이 갖춰지는 `registerWebsocket` 조립 단계에서야 만들 수 있다. 슬롯의 `onCombatTick`을 먼저
 * creatureTick deps에 넘기고, 핸들러가 준비되면 `bind`로 꽂는다. 레이어 규약상 world 레이어는
 * 전투 레이어를 import하지 않으므로 이 파일은 `world/creatureTick.ts`가 소유한 `OnCombatTick` 타입만 쓴다.
 *
 * ## 바인딩 전 no-op이 안전한 근거
 * 바인딩 전 구간은 boot부터 `registerWebsocket`까지다. 이 구간에는 플레이어 세션이 하나도 없어 전투
 * 대상이 존재하지 않으므로, 이때의 디스패치를 버려도 잃는 라운드가 없다. 버려진 호출은 나중에
 * 바인딩된 핸들러로 소급 전달하지 않는다.
 *
 * ## 2회 바인딩 금지 근거
 * 슬롯은 프로세스당 1회 만들고 1회 꽂는다. 두 번째 `bind`는 조립 경로가 중복됐다는 뜻이고, 조용히
 * 덮어쓰면 어느 핸들러가 살아 있는지 알 수 없게 된다. 그래서 즉시 throw해 조립 오류를 드러내고 첫
 * 핸들러를 유지한다.
 *
 * ## 참조 안정성
 * `onCombatTick`은 바인딩 전후로 같은 함수 참조다. creatureTick은 생성 시점에 이 참조를 캡처하므로,
 * 참조가 바뀌면 바인딩이 반영되지 않는다.
 */
export interface CombatTickBinding {
  /** creatureTick deps에 넘길 디스패치. 바인딩 전 no-op, 바인딩 후 핸들러에 그대로 위임한다. */
  readonly onCombatTick: OnCombatTick
  /** 실 전투 핸들러를 꽂는다. 두 번째 호출은 조립 오류로 throw한다. */
  bind(handler: OnCombatTick): void
}

export function createCombatTickBinding(): CombatTickBinding {
  let bound: OnCombatTick | null = null

  return {
    onCombatTick(creature, room): void {
      bound?.(creature, room)
    },
    bind(handler: OnCombatTick): void {
      if (bound !== null) {
        throw new Error('조립 오류: 전투 tick 핸들러가 이미 바인딩됐다(bind는 1회만 허용)')
      }
      bound = handler
    },
  }
}
