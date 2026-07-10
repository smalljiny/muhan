import type { ActorContext } from './actorContext.js'

/**
 * 채널 전달 포트 — 검증된 채팅 명령을 채널 전파 계층으로 핸드오프하는 도메인 계약의 단일 출처.
 *
 * 이 인터페이스는 실 브로드캐스트(방=채널 delivery·인접 방 전파·전서버 방송·구독 필터)를 표현하지
 * 않는다. 게임 채팅 도메인 언어(누가·어느 채널로·무엇을·누구에게)로만 표현하며, 실 전파는 포트 뒤
 * 어댑터 교체로 붙는다(DIP seam). E3에는 실 전파를 두지 않고 no-op 로깅 어댑터로만 만족한다.
 * sessionLifecyclePort.ts의 seam 관례를 미러한다.
 *
 * 동기 시그니처: no-op stub이라 deliver가 Promise를 반환하지 않는다. E4(방=채널)·E7(채널·구독)의 실
 * 어댑터는 네트워크 fan-out으로 async가 필요하므로, 그 시점에 포트를 `Promise<void>` 반환으로 확장하고
 * 호출부(채팅 핸들러)를 조정한다. 지금은 async seam을 주석으로만 남기고 동기로 유지한다.
 */

/** 채널 전달 컨텍스트 — 발화자·채널·내용 + 선택적 대상. target은 값이 있을 때만 키를 싣는다. */
export interface ChannelDeliveryContext {
  readonly speaker: ActorContext
  readonly channel: 'say' | 'yell' | 'broadcast' | 'emote'
  readonly text: string
  readonly target?: string
}

/**
 * 채널 전달 포트 계약. 구현체는 자체 로거·전파 자원을 생성자로 소유한다(서비스 로케이터·전역 싱글턴 금지).
 * 채팅 핸들러가 검증된 채팅 명령마다 fire-and-forget으로 호출한다(반환값 없음).
 */
export interface ChannelPort {
  /** 발화를 채널 전파 계층으로 전달한다. E3 no-op 어댑터는 전달 사실만 로깅한다. */
  deliver(ctx: ChannelDeliveryContext): void
}

/**
 * 채널별 선언 메타 — E3는 어느 항목도 강제하지 않는다(선언만). audience·cost는 ChannelPort 소유(강제
 * E4/E7), gate(레벨/클래스 실행 자격)는 PermissionPort 개념 영역(강제 E5). Open Q2.
 *
 * audience는 전파 범위(room=방 내부, zone=인접 방 1홉, global=전서버), cost는 발화 자원 비용(HP·일일
 * 한도), gate는 실행 자격(minLevel=레벨 문턱)이다. broadcast.gate.minLevel=20은 spec §3.4의 "레벨20"
 * 방송 자격 선언이다 — E3는 이 값을 읽지도 강제하지도 않고 후속 에픽 어댑터를 위한 선언으로만 고정한다.
 * `as const`로 리터럴을 고정해 오타·구조 드리프트를 컴파일 타임에 차단한다.
 */
export const CHANNEL_METADATA = {
  say: { audience: 'room', cost: { hp: 0, dailyLimit: null }, gate: { minLevel: 0 } },
  yell: { audience: 'zone', cost: { hp: 0, dailyLimit: null }, gate: { minLevel: 0 } },
  broadcast: { audience: 'global', cost: { hp: 0, dailyLimit: 10 }, gate: { minLevel: 20 } },
  emote: { audience: 'room', cost: { hp: 0, dailyLimit: null }, gate: { minLevel: 0 } },
} as const
