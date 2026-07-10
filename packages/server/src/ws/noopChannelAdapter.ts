import type { ChannelPort } from './channelPort.js'

/**
 * ChannelPort의 no-op 로깅 구현.
 *
 * mock이 아니라 실제 어댑터다 — 전달 사실만 로깅하고 채널 fan-out은 하지 않는다(E4/E7이 실 전파로
 * 교체한다). 생성자 주입 관례(전역 싱글턴을 조회하지 않는다)로 로거를 받아 소유한다.
 * noopSessionLifecycleAdapter.ts의 seam 관례를 미러한다.
 */

/** 어댑터가 의존하는 최소 로거 표면. Fastify의 app.log(pino)가 구조적으로 충족한다. */
export interface ChannelLogger {
  info(obj: object, msg: string): void
}

/**
 * no-op 채널 어댑터를 만든다. deliver는 전달 사실(speaker의 characterId·channel·target)만 구조 로깅하고
 * 즉시 반환한다. characterId·channel·target은 PII가 아니라 도메인 식별자이므로 마스킹 없이 로깅한다.
 */
export function createNoopChannelAdapter(logger: ChannelLogger): ChannelPort {
  return {
    deliver(ctx) {
      logger.info(
        { characterId: ctx.speaker.characterId, channel: ctx.channel, target: ctx.target },
        'channel delivery (no-op broadcast)',
      )
    },
  }
}
