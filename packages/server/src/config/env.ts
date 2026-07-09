import { z } from 'zod'

// 환경변수 스키마 — 시작 시 파싱해 잘못된 설정이면 즉시 종료한다.
// MONGODB_URI는 존재만 검증한다(z.string().min(1)). z.url()은 generic URL 검증이라
// 유효한 seed-list 복제셋 URI(mongodb://h1:27017,h2:27017/db)를 false-reject하므로,
// 연결 문자열 문법 검증은 드라이버(Story 4 connectMongo)에 맡기고 여기선 부재만 잡는다.
// 빈 문자열(.env의 KEY= )은 .default()를 우회하므로 문자열 필드에 .min(1)을 건다.
// zod 4 관용: z.flattenError(구식 error.flatten() 대신).
export const EnvSchema = z.object({
  MONGODB_URI: z.string().min(1),
  // WS upgrade Origin allowlist. default 없이 fail-fast(MONGODB_URI 패턴 동일) — 미설정 부팅을
  // 막아 CSWSH 방어 정책을 명시 설정으로 강제한다. 콤마 구분 문자열을 origin 배열로 transform하고,
  // 각 항목을 trim·빈 항목 제거한 뒤 .refine으로 최소 1개를 보장한다(빈 문자열·공백뿐·콤마뿐 거부).
  WS_ALLOWED_ORIGINS: z
    .string()
    .min(1)
    .transform((s) =>
      s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    )
    .refine((arr) => arr.length > 0, { message: '최소 하나의 origin이 필요하다' }),
  MONGODB_DB_NAME: z.string().min(1).default('muhan_db_dev'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  // 서버 주도 하트비트 튜닝(Story 5). ping 간격마다 직전 라운드 pong 미수신을 세고, 연속 미수신이
  // MAX_MISSED에 도달하면 소켓을 terminate한다. 첫 인터벌은 미스를 세지 않고 ping만 보내므로(초기
  // awaitingPong=false) 종료까지 ≈ PING_INTERVAL × (MAX_MISSED + 1)이다(기본값 25s·3 → ≈ 100s).
  WS_HEARTBEAT_PING_INTERVAL_MS: z.coerce.number().int().min(1).default(25000),
  // 예약 seam: 현재 단일 인터벌(isAlive) 모델은 이 값을 소비하지 않는다. 유효 per-pong 마감은
  // 이 값이 아니라 PING_INTERVAL이다 — 이 필드를 낮춰도 종료 타이밍은 바뀌지 않는다(향후 이중
  // 타이머 모델이 도입되면 소비). 운영자 오도를 막기 위해 무효임을 명시한다.
  WS_HEARTBEAT_PONG_TIMEOUT_MS: z.coerce.number().int().min(1).default(10000),
  WS_HEARTBEAT_MAX_MISSED: z.coerce.number().int().min(1).default(3),
  // per-connection 진행 데드라인(Story 6). 세션 FSM이 이 시간 안에 진행(상태 전이 또는 create 서브상태
  // 전진)하지 않으면 소켓을 graceful close(terminate 아님)한다. 하트비트(물리 생존)와 별도 슬롯으로
  // 관리되는 논리 진행 데드라인이며, 상태 전이·서브상태 전진마다 재설정(rearm)된다. 0이면 진입 즉시
  // reap되어 무의미하므로 최소 1을 강제한다.
  WS_SESSION_DEADLINE_MS: z.coerce.number().int().min(1).default(60000),
})

export type Env = z.infer<typeof EnvSchema>

let configInstance: Env | undefined

export function getConfig(): Env {
  if (configInstance) return configInstance
  const result = EnvSchema.safeParse(process.env)
  if (!result.success) {
    console.error('Invalid environment variables:', z.flattenError(result.error).fieldErrors)
    process.exit(1)
  }
  configInstance = result.data
  return configInstance
}

/**
 * 테스트 전용 — 캐시된 싱글턴을 초기화한다.
 * process.env를 조작하는 테스트 간 격리를 위해서만 사용한다.
 */
export function resetConfigForTests(): void {
  configInstance = undefined
}
