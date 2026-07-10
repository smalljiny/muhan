import { z } from 'zod'

// 환경변수 스키마 — 시작 시 파싱해 잘못된 설정이면 즉시 종료한다.
// MONGODB_URI는 존재만 검증한다(z.string().min(1)). z.url()은 generic URL 검증이라
// 유효한 seed-list 복제셋 URI(mongodb://h1:27017,h2:27017/db)를 false-reject하므로,
// 연결 문자열 문법 검증은 드라이버(Story 4 connectMongo)에 맡기고 여기선 부재만 잡는다.
// 빈 문자열(.env의 KEY= )은 .default()를 우회하므로 문자열 필드에 .min(1)을 건다.
// zod 4 관용: z.flattenError(구식 error.flatten() 대신).
export const EnvSchema = z.object({
  // 런타임 환경 구분. DEV_LOGIN_ENABLED 단일 플래그가 유일한 방어선이 되지 않도록 fail-closed 게이트를
  // getConfig에 둔다. default를 두지 않는다 — 기본값(development)을 두면 NODE_ENV 미설정 배포에서
  // dev 로그인이 fail-open으로 허용된다. free string으로 받아(staging 등 임의 값이 dev 로그인 off일 때
  // 서버를 crash시키지 않게) 게이트에서 명시적 development/test만 허용한다.
  NODE_ENV: z.string().optional(),
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
  // 재연결 grace 창(Story 5, G3). command 상태 소켓의 클라 주도 drop 감지 시 바인딩을 즉시 제거하지 않고
  // link-dead로 표시한 뒤 이 시간 안에 같은 캐릭터로 재접속하면 rebind(재연결)한다. 만료되면 disconnect
  // 수렴 seam(resolveDisconnect(graceExpired))으로 정식 종료한다. 진행 데드라인·idle과 별개 타이머다.
  // 0이면 link-dead 진입 즉시 만료돼 재연결 창이 무의미하므로 최소 1을 강제한다.
  WS_RECONNECT_GRACE_MS: z.coerce.number().int().min(1).default(30000),
  // 월드 진입(command) 후 무입력(idle) 종료 창(Story 6, G4). command 진입 시 arm하고 유효 명령 처리
  // 성공(dispatch handled)마다 재-arm한다. 이 시간 안에 유효 명령이 없으면 disconnect 수렴 seam
  // (resolveDisconnect(idleTimeout))으로 정식 종료한다. 하트비트(물리 생존)·진행 데드라인(핸드셰이크 진행)·
  // grace(재연결 창)와 별개 타이머다. 0이면 진입 즉시 만료돼 무입력 감시가 무의미하므로 최소 1을 강제한다.
  WS_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1).default(300000),
  // dev 전용 로그인 게이트(Story 4, G1 서버측). true일 때만 /dev/login 라우트가 마운트되고 시드
  // SessionAuthPort 어댑터가 배선된다. z.coerce.boolean은 비어있지 않은 문자열 "false"를 true로
  // 강제하므로 금지 — enum(['true','false'])로 명시 허용값을 강제하고 transform으로 boolean화한다.
  DEV_LOGIN_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((s) => s === 'true'),
  // 시드 세션 쿠키·계정 식별자. 플래그 off일 때도 파싱이 실패하지 않도록 빈 문자열 default를 둔다.
  // 플래그 on인데 값이 비면 devSeedSessionAuth 조립 단계에서 fail-fast로 방어한다(빈 유효 쿠키 배포 방지).
  DEV_SEED_COOKIE: z.string().default(''),
  DEV_SEED_ACCOUNT_ID: z.string().default(''),
})

export type Env = z.infer<typeof EnvSchema>

let configInstance: Env | undefined

export function getConfig(): Env {
  if (configInstance) return configInstance
  const result = EnvSchema.safeParse(process.env)
  if (!result.success) {
    console.error('Invalid environment variables:', z.flattenError(result.error).fieldErrors)
    process.exit(1)
  } else if (
    result.data.DEV_LOGIN_ENABLED &&
    result.data.NODE_ENV !== 'development' &&
    result.data.NODE_ENV !== 'test'
  ) {
    // 2차 방어선(fail-closed): dev 로그인은 NODE_ENV가 명시적으로 development/test일 때만 허용한다.
    // production·미설정·기타 값이면 부팅 차단 — orchestrator 설정 실수(env 잔존)나 NODE_ENV 누락으로
    // 인한 완전 인증 우회를 코드 레벨로 막는다.
    console.error('DEV_LOGIN_ENABLED requires NODE_ENV=development or test')
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
