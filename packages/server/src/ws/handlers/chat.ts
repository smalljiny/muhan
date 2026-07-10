import type { ClientCommand } from 'shared'
import type { CommandHandler } from '../router.js'
import type { ChannelDeliveryContext, ChannelPort } from '../channelPort.js'

/**
 * 자유채팅 핸들러 팩토리 — 검증된 채팅 명령을 ChannelPort로 핸드오프한다.
 *
 * `channelPort`를 클로저로 받아 반환 핸들러가 `(command, actor)` 2-param CommandHandler 계약을 유지한다.
 * 라우터가 chat:message·chat:emote type에만 이 핸들러를 배선하므로, 그 외 갈래는 구조적으로 도달 불가한
 * 방어선이다. fire-and-forget이라 항상 undefined를 반환한다(응답 이벤트 없음).
 *
 * 게이트 메타(CHANNEL_METADATA.*.gate)를 참조하지 않고 무조건 deliver한다 — E3는 채널 게이트를 선언만
 * 하고 강제하지 않는다(강제는 E4/E5/E7 어댑터의 책임).
 *
 * 매핑:
 * - chat:message → { speaker, channel: command.channel, text: command.text }
 * - chat:emote → { speaker, channel: 'emote', text: command.emote, target: command.target? }
 *   별칭(emote)이 주 콘텐츠라 text에 command.emote를 싣는다. 선택적 부가 command.text는 E3에서 드롭한다
 *   (별칭 해소는 E7로 유예). target은 값이 있을 때만 키를 실어 undefined 키를 금지한다(errorEvent 관례 미러).
 */
export function createChatHandler(channelPort: ChannelPort): CommandHandler {
  return (command: ClientCommand, actor): undefined => {
    if (command.type === 'chat:message') {
      channelPort.deliver({ speaker: actor, channel: command.channel, text: command.text })
      return undefined
    }
    if (command.type === 'chat:emote') {
      const ctx: ChannelDeliveryContext =
        command.target !== undefined
          ? { speaker: actor, channel: 'emote', text: command.emote, target: command.target }
          : { speaker: actor, channel: 'emote', text: command.emote }
      channelPort.deliver(ctx)
      return undefined
    }
    return undefined
  }
}
