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
  // Firebase 프로젝트 식별자 — 실 세션 쿠키 검증 어댑터(DEV_LOGIN off 경로) 조립에만 쓰인다.
  // dev 부팅(DEV_LOGIN on)은 이 값을 요구하지 않으므로 optional로 둔다. 실 어댑터 조립 시점(index.ts)에서
  // 부재를 fail-fast로 방어한다 — optional 스키마가 프로덕션 경로의 fail-fast를 대체하지 않는다.
  FIREBASE_PROJECT_ID: z.string().optional(),
  // 시드 세션 쿠키·계정 식별자. 플래그 off일 때도 파싱이 실패하지 않도록 빈 문자열 default를 둔다.
  // 플래그 on인데 값이 비면 devSeedSessionAuth 조립 단계에서 fail-fast로 방어한다(빈 유효 쿠키 배포 방지).
  DEV_SEED_COOKIE: z.string().default(''),
  DEV_SEED_ACCOUNT_ID: z.string().default(''),
  // 전역 동시 연결 정원(Story 2). WS 서버가 동시에 유지하는 소켓 총량의 상한이며, 초과 시 신규
  // upgrade를 거부해 파일 디스크립터·메모리 고갈을 막는다. WS_ALLOWED_ORIGINS(보안 정책, no default)와
  // 달리 자원 한도는 운영 규모에 맞춰 튜닝하는 값이라 합리적 기본값(1000)을 둔다. 0이면 어떤 연결도
  // 수용 못 해 서버가 무의미하므로 최소 1을 강제한다.
  WS_MAX_CONNECTIONS: z.coerce.number().int().min(1).default(1000),
  // 계정별 동시 연결 정원(Story 2). 한 계정이 동시에 유지할 수 있는 소켓 수의 상한이며, 초과 시 신규
  // upgrade를 거부해 단일 계정의 연결 독점(자원 고갈)을 막는다. 정상 사용(다중 탭·재연결 겹침)을
  // 허용하되 남용은 차단하는 절충값으로 기본값(5)을 둔다. 0이면 어떤 계정도 접속 못 해 무의미하므로
  // 최소 1을 강제한다.
  WS_MAX_CONNECTIONS_PER_ACCOUNT: z.coerce.number().int().min(1).default(5),
  // 아웃바운드 큐 상한(Story 2). per-connection 송신 버퍼(bufferedAmount)가 이 바이트 수를 넘으면
  // 느린 소비자(slow consumer)로 판정해 소켓을 종료, 서버 메모리 누적을 막는다. 정상 메시지 버스트를
  // 흡수하되 backpressure 미해소 소켓은 잘라내는 절충값으로 기본값 1MB(1048576)를 둔다. 0이면 어떤
  // 아웃바운드도 즉시 초과로 판정돼 무의미하므로 최소 1을 강제한다.
  WS_MAX_BUFFERED_BYTES: z.coerce.number().int().min(1).default(1048576),
  // 인바운드 메시지 유량 상한(E3 hardening). 인증된 WS 연결의 프레임 도착률을 연결별·계정별 토큰
  // 버킷으로 제한해, 읽기는 정상이면서 프레임을 고속 flood해 파싱·dispatch CPU를 소진시키는 공격을
  // 차단한다. WS_MAX_* 관례를 미러해 fail-fast(.int().min(1).default())로 두어, 미설정 부팅을 막지
  // 않으면서 잘못된 값(0)은 즉시 거부한다.
  //
  // 연결당 버스트 허용 토큰 수. 연결 10/s 지속 + 20 버스트는 사람 입력(피크 1~3 cmd/s) 대비 넉넉하되
  // flood(수백/s)는 즉시 포착한다. 0이면 어떤 프레임도 통과 못 해 무의미하므로 최소 1을 강제한다.
  WS_MSG_RATE_CAPACITY: z.coerce.number().int().min(1).default(20),
  // 연결당 초당 리필(지속율). 사람의 지속 입력율을 넉넉히 덮되 flood는 못 따라오는 값.
  WS_MSG_RATE_REFILL_PER_SEC: z.coerce.number().int().min(1).default(10),
  // 계정당 버스트 토큰 수. connectionQuota 계정당 5연결 하에 다중 탭 정상 사용은 허용하되 다중 연결
  // flood의 집계는 잡는 값.
  WS_MSG_RATE_ACCOUNT_CAPACITY: z.coerce.number().int().min(1).default(40),
  // 계정당 초당 리필. 연결 지속율(10)의 다중 연결 합을 흡수하되 계정 차원 flood는 억제하는 값.
  WS_MSG_RATE_ACCOUNT_REFILL_PER_SEC: z.coerce.number().int().min(1).default(20),
  // 연속 위반 종료 임계. 일시 버스트(accept가 카운터 리셋)엔 여유를 주되 지속 flooder는 빠르게 초과해
  // graceful close된다. env 튜닝 가능이라 정확값은 저위험이다.
  WS_MSG_RATE_MAX_VIOLATIONS: z.coerce.number().int().min(1).default(10),
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
