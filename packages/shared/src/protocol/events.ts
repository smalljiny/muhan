import { z } from 'zod'
import { freeTextPayloadSchema, CHAT_TEXT_MAX, CHAT_TARGET_MAX } from './payloads.js'
import { characterSummarySchema, promptKindSchema, promptOptionSchema } from './session.js'

/**
 * 오류 코드 열거 — error 이벤트가 싣는 기계 판독용 사유의 단일 출처.
 *
 * handshake_required(핸드셰이크 전 명령 수신), unknown_type(미지 discriminator),
 * bad_payload(payload 형식 위반), internal(서버 내부 오류),
 * unauthorized(인증되지 않은 세션의 명령 수신), session_state(현재 세션 단계에서 허용되지 않는 명령).
 *
 * unauthorized와 forbidden은 client-visible 의미가 다르다:
 * - unauthorized = **미인증** 세션이 명령을 보냈다(신원 자체가 없다 — 핸드셰이크·로그인 필요).
 * - forbidden = **인증된** 세션이나 RBAC 권한이 부족해 거부됐다(신원은 있으나 자격이 없다 — Open Q3).
 * 클라이언트는 unauthorized에는 재인증을, forbidden에는 권한 없음 안내를 띄우도록 두 코드를 구분한다.
 */
export const errorCodeSchema = z.enum([
  'handshake_required',
  'unknown_type',
  'bad_payload',
  'internal',
  'unauthorized',
  'session_state',
  'forbidden',
  // rate_limited = 인바운드 프레임이 연결·계정 속도 상한을 초과해 파싱 전 drop됐다(1회 경고 통지).
  'rate_limited',
  // rule_rejected = 게임 규칙에 의한 거부(잠긴 문·막힌 길). forbidden(RBAC 자격 없음)·bad_payload(형식
  // 위반)·session_state(현재 단계에서 불허)·internal(서버 오류)와 구분한다 — 형식·권한·단계는 옳으나
  // 게임 세계의 규칙이 명령을 막은 경우다(D-D).
  'rule_rejected',
])

/**
 * server→client 이벤트 봉투 — 판별 유니온의 단일 출처.
 *
 * top-level `type` 리터럴로 이벤트를 판별한다(objectOwnerSchema 관용구와 동일). 각 variant는
 * 리터럴 discriminator를 둔 strictObject다. debug:echo:result는 자유 텍스트 payload building block의
 * shape를 새 strictObject에 spread해 재사용하되, 리터럴 discriminator·strict를 확실히 보존한다.
 */
export const serverEventSchema = z.discriminatedUnion('type', [
  // 핸드셰이크 응답 — server가 자신의 프로토콜 버전을 실어 되돌린다.
  z.strictObject({
    type: z.literal('system:hello'),
    protocolVersion: z.int(),
  }),
  // 월드/세션 리로드 통지 — client에게 재연결·재동기를 지시한다. reason은 사람용 사유.
  z.strictObject({
    type: z.literal('system:reload'),
    reason: z.string().min(1),
  }),
  // 진단용 echo 응답 — 요청 text를 되돌린다. correlationId는 요청 id와 짝짓는 상관 키.
  z.strictObject({
    type: z.literal('debug:echo:result'),
    ...freeTextPayloadSchema.shape,
    correlationId: z.string().optional(),
  }),
  // 오류 통지 — code는 기계 판독, message는 사람용. correlationId는 유발 명령과의 상관 키.
  z.strictObject({
    type: z.literal('error'),
    code: errorCodeSchema,
    message: z.string().min(1),
    correlationId: z.string().optional(),
  }),
  // 세션 prompt 제시 — promptId로 질문을 식별하고, kind로 단계를, options로 선택지를 싣는다.
  z.strictObject({
    type: z.literal('session:prompt'),
    promptId: z.string().min(1),
    kind: promptKindSchema,
    options: z.array(promptOptionSchema).optional(),
  }),
  // 캐릭터 목록 통지 — 선택 화면이 실을 와이어 전용 요약 배열.
  z.strictObject({
    type: z.literal('session:characterList'),
    characters: z.array(characterSummarySchema),
  }),
  // 세션 입장 확정 — characterId가 지목한 캐릭터로 월드에 진입했음을 통지한다.
  z.strictObject({
    type: z.literal('session:entered'),
    characterId: z.string().min(1),
  }),
  // 세션 재개 확정 — 재연결 시 characterId가 지목한 기존 세션으로 복귀했음을 통지한다.
  z.strictObject({
    type: z.literal('session:resumed'),
    characterId: z.string().min(1),
  }),
  // 방 통지 — 이동/입장 성공 시 본인에게 1회 발화하는 방 스냅샷. 방 id·이름·설명·출구 이름 목록에
  // 더해 눈에 보이는 점유자·바닥 아이템·크리처를 싣는다(서버 `projectRoomView`가 오라클 방 표시 규칙으로
  // 숨김 개체·비밀 출구를 이미 걸러 낸다). 스냅샷이지 실시간 델타가 아니다 — 다른 사람의 입·퇴장은 다음
  // world:room까지 반영되지 않는다(#116).
  //
  // `name`·`longDesc`는 빈 문자열이 유효하다 — 정본 월드 데이터에 빈 name 97방·빈 longDesc 433방이
  // 실재하며, 대체 문구('이름 없는 곳'·'설명이 없다.') 선택은 표시 계층의 관심사다.
  // `exits`는 이름 문자열 배열을 유지한다 — 문 잠김·닫힘 상태를 노출하지 않고, 버튼을 눌러 막히면
  // 서버가 error{rule_rejected}로 답한다(OQ3). `shortDesc`는 2341방 중 2327방이 빈 문자열이라 싣지 않는다.
  // `occupants`는 본인을 포함한다 — 본인 제외는 클라이언트가 수행한다.
  z.strictObject({
    type: z.literal('world:room'),
    roomId: z.int().min(0),
    name: z.string(),
    longDesc: z.string(),
    exits: z.array(z.string()),
    occupants: z.array(z.strictObject({ characterId: z.string().min(1), name: z.string().min(1) })),
    items: z.array(z.strictObject({ instanceId: z.string().min(1), name: z.string() })),
    creatures: z.array(
      z.strictObject({
        instanceId: z.string().min(1),
        name: z.string(),
        level: z.int().min(0),
      }),
    ),
  }),
  // 채팅 발화 통지 — ChannelDeliveryContext와 1:1 매핑(speaker→speakerCharacterId로 평탄화). 인바운드
  // chat:message와 이름을 달리해(said vs message) 방향을 판별한다(D-E). channel은 채널 전달 컨텍스트와 동일
  // 열거, text·target 상한은 인바운드 chat 명령과 같은 값을 아웃바운드에도 적용한다.
  z.strictObject({
    type: z.literal('chat:said'),
    channel: z.enum(['say', 'yell', 'broadcast', 'emote']),
    speakerCharacterId: z.string().min(1),
    text: z.string().min(1).max(CHAT_TEXT_MAX),
    target: z.string().min(1).max(CHAT_TARGET_MAX).optional(),
  }),
  // 연마 성공 통지 — train()이 확정한 성장 결과 스냅샷을 본인에게 1회 발화한다(D-C 최소 상태 통지).
  // world:room 선례를 따라 correlationId를 싣지 않는다(상태 이벤트 — 거부만 error로 상관 키를 반향한다).
  // stats는 characterSchema.stats와 동일한 5-튜플이다 — 와이어 계약이라 길이 드리프트를 타입으로 막는다.
  // 나머지 numeric 필드도 characterSchema의 하한을 그대로 미러한다 — 클라(wsClient)가 인바운드
  // 프레임을 이 스키마로 safeParse하므로 형식적 정합이 아니라 실 입력 검증 표면이다.
  // prestige는 이번 연마의 승급 결과(무적·초인 전이 또는 일반 상승)다.
  z.strictObject({
    type: z.literal('progress:trained'),
    level: z.int().min(1),
    // 승급(무적·초인) 경로는 레벨을 올리지 않고 전이만 하므로 0이 유효하다.
    levelsGained: z.int().min(0),
    experience: z.int().min(0),
    gold: z.int().min(0),
    hpCurrent: z.int().min(0),
    mpCurrent: z.int().min(0),
    stats: z.tuple([z.int(), z.int(), z.int(), z.int(), z.int()]),
    prestige: z.enum(['invincible', 'caretaker', 'none']),
  }),
])

export type ErrorCode = z.infer<typeof errorCodeSchema>
export type ServerEvent = z.infer<typeof serverEventSchema>
