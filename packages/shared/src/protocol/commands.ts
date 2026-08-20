import { z } from 'zod'
import {
  freeTextPayloadSchema,
  targetOrdinalPayloadSchema,
  CHAT_TEXT_MAX,
  CHAT_TARGET_MAX,
} from './payloads.js'

/**
 * 감정표현 별칭(emote)의 상한 — 인바운드 chat:emote 전용이라 아웃바운드와 공유하지 않고 여기 둔다.
 * text·target 상한은 아웃바운드 chat:said와 공유하므로 payloads.ts(CHAT_TEXT_MAX·CHAT_TARGET_MAX)에
 * 단일 출처를 둔다. 프레임 상한(MAX_FRAME_BYTES)은 프레임 전체만 막으므로 전파 대상 필드는 필드 단위
 * 상한을 둔다(DoS 방어 floor).
 */
const CHAT_EMOTE_MAX = 64

/**
 * client→server 명령 봉투 — 판별 유니온의 단일 출처.
 *
 * top-level `type` 리터럴로 명령을 판별한다(objectOwnerSchema 관용구와 동일). 각 variant는
 * 리터럴 discriminator를 둔 strictObject다. debug:echo는 자유 텍스트 payload building block의
 * shape를 새 strictObject에 spread해 재사용하되, 리터럴 discriminator·strict를 확실히 보존한다.
 */
export const clientCommandSchema = z.discriminatedUnion('type', [
  // 핸드셰이크 개시 — client가 자신이 아는 프로토콜 버전을 실어 보낸다.
  z.strictObject({
    type: z.literal('system:ready'),
    protocolVersion: z.int(),
  }),
  // 진단용 echo 요청 — text를 그대로 되돌려 받는다. id는 client가 응답을 짝짓는 상관 키.
  z.strictObject({
    type: z.literal('debug:echo'),
    ...freeTextPayloadSchema.shape,
    id: z.string().optional(),
  }),
  // 세션 prompt 응답 — promptId가 지목한 질문에 value로 답한다. id는 응답을 짝짓는 상관 키.
  // value는 자유 사용자 입력(이름·선택값)이라 거친 외곽 상한(256)을 둔다 — 도메인별 세부 상한은
  // 각 prompt 핸들러(예: 캐릭터 이름 max 40)가 추가로 강제한다(다층 방어).
  z.strictObject({
    type: z.literal('session:reply'),
    promptId: z.string().min(1),
    value: z.string().min(1).max(256),
    id: z.string().optional(),
  }),
  // 캐릭터 선택 — characterId로 입장할 캐릭터를 지목한다. id는 응답을 짝짓는 상관 키.
  z.strictObject({
    type: z.literal('session:selectCharacter'),
    characterId: z.string().min(1),
    id: z.string().optional(),
  }),
  // 자유채팅 — 채널로 발화 대상 범위를 지목한다. text는 발화 내용. id는 상관 키.
  // text는 freeTextPayloadSchema를 spread하지 않고 직접 선언한다 — 채널 전파 대상이라 CHAT_TEXT_MAX
  // 상한을 둬야 하는데, spread한 building block의 text는 상한이 없다(debug:echo는 fan-out이 아니라 무상한 유지).
  z.strictObject({
    type: z.literal('chat:message'),
    channel: z.enum(['say', 'yell', 'broadcast']),
    text: z.string().min(1).max(CHAT_TEXT_MAX),
    id: z.string().optional(),
  }),
  // 감정표현 — emote 별칭(값 검증은 E7 — Open Q4). target은 대상 캐릭터(선택). text는 선택적 부가 텍스트.
  // freeTextPayloadSchema.shape를 spread하지 않는다 — 그 shape의 text는 필수라 "선택적 부가 text"
  // 의도와 충돌한다. 따라서 text를 optional로 직접 선언한다. 세 자유 텍스트 필드에 상한을 둔다(전파 대상).
  z.strictObject({
    type: z.literal('chat:emote'),
    emote: z.string().min(1).max(CHAT_EMOTE_MAX),
    target: z.string().min(1).max(CHAT_TARGET_MAX).optional(),
    text: z.string().min(1).max(CHAT_TEXT_MAX).optional(),
    id: z.string().optional(),
  }),
  // 이동 명령 — direction은 방 그래프 출구 이름과 정확 일치할 문자열이다(방 데이터의 출구 이름을 그대로 지목).
  // 상한 32는 입력 위생(방 그래프 어떤 출구 이름도 이 안에 든다 — 초과 입력은 형식 위반으로 조기 차단).
  // mode(단축키·방향 별칭) 해소는 클라 책임이다 — 서버는 해소된 최종 direction 문자열만 받는다(D-B). id는 상관 키.
  z.strictObject({
    type: z.literal('world:move'),
    direction: z.string().min(1).max(32),
    id: z.string().optional(),
  }),
  // 연마 명령 — 인자가 없다. 훈련방 여부·클래스 일치·exp·gold 게이트는 전부 서버(progression/train)가
  // 소유하므로 클라는 의도만 보낸다(대상·수량 같은 인자 표면을 두지 않아 입력 위생 부담이 0이다).
  // id는 상관 키(선택) — 성공 통지 progress:trained는 상태 이벤트라 상관 키를 싣지 않고, 거부 시
  // error 이벤트가 이 id를 correlationId로 반향한다.
  z.strictObject({
    type: z.literal('progress:train'),
    id: z.string().optional(),
  }),
  // 연마(주문 학습) 명령 — 소지품에서 비법서를 지목해 주문을 익힌다. progress:train과 달리 인자가 있다
  // (오라클 `study`는 대상 아이템을 요구한다). 클래스·레벨·중복 습득 게이트는 서버가 소유하고, 클라는
  // 대상 지목만 보낸다. id는 상관 키(선택) — progress:studied는 상태 이벤트라 상관 키를 싣지 않고,
  // 거부 시 error 이벤트가 이 id를 correlationId로 반향한다.
  //
  // target·ordinal 형상과 그 상한 근거는 payloads.ts의 targetOrdinalPayloadSchema가 소유한다.
  // 그 블록을 spread해 리터럴 상한이 명령마다 흩어지는 것을 막는다(debug:echo가 freeTextPayloadSchema를
  // spread하는 관용구와 같다 — 리터럴 discriminator와 strict는 새 strictObject가 그대로 보존한다).
  z.strictObject({
    type: z.literal('progress:study'),
    ...targetOrdinalPayloadSchema.shape,
    id: z.string().optional(),
  }),
  // 공격 명령 — 방 안의 대상을 지목해 전투를 개시한다. 대상 해소는 방 대상 해소자가 소유하고,
  // 명중·피해·사망 판정은 전부 서버(combat)가 소유한다. 클라는 지목만 보낸다.
  // id는 상관 키(선택) — 성공 통지 combat:attacked는 상태 이벤트라 상관 키를 싣지 않고, 거부 시
  // error 이벤트가 이 id를 correlationId로 반향한다(progress:study 선례).
  //
  // progress:study와 같은 "대상 + 서수" 패턴이라 같은 building block을 spread한다.
  z.strictObject({
    type: z.literal('combat:attack'),
    ...targetOrdinalPayloadSchema.shape,
    id: z.string().optional(),
  }),
])

export type ClientCommand = z.infer<typeof clientCommandSchema>
