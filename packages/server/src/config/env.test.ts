import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getConfig, resetConfigForTests } from './env.js'

// process.env를 테스트마다 저장/복원하고 싱글턴 캐시를 초기화해 격리를 보장한다.
describe('getConfig', () => {
  let savedEnv: NodeJS.ProcessEnv

  beforeEach(() => {
    savedEnv = { ...process.env }
    resetConfigForTests()
  })

  afterEach(() => {
    process.env = savedEnv
    resetConfigForTests()
    vi.restoreAllMocks()
  })

  it('유효한 env를 검증된 객체로 반환하고 기본값을 채운다', () => {
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
    delete process.env.MONGODB_DB_NAME
    delete process.env.PORT

    const config = getConfig()

    expect(config.MONGODB_URI).toBe('mongodb://localhost:27017')
    expect(config.MONGODB_DB_NAME).toBe('muhan_db_dev')
    expect(config.PORT).toBe(3000)
  })

  it('PORT 환경변수를 숫자로 강제 변환한다', () => {
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
    process.env.PORT = '8080'

    const config = getConfig()

    expect(config.PORT).toBe(8080)
  })

  it('두 번 호출하면 동일 인스턴스를 반환한다(싱글턴)', () => {
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'

    const first = getConfig()
    const second = getConfig()

    expect(first).toBe(second)
  })

  it('WS_ALLOWED_ORIGINS 콤마 구분 문자열을 origin 배열로 파싱한다', () => {
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost,https://muhan.example'

    const config = getConfig()

    expect(config.WS_ALLOWED_ORIGINS).toEqual(['http://localhost', 'https://muhan.example'])
  })

  it('WS_ALLOWED_ORIGINS 항목의 공백을 trim하고 빈 항목을 버린다', () => {
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = ' http://localhost , , https://muhan.example '

    const config = getConfig()

    expect(config.WS_ALLOWED_ORIGINS).toEqual(['http://localhost', 'https://muhan.example'])
  })

  it('WS_ALLOWED_ORIGINS가 없으면 fail-fast로 종료한다', () => {
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    delete process.env.WS_ALLOWED_ORIGINS
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    getConfig()

    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('WS_ALLOWED_ORIGINS가 빈 문자열이면 fail-fast로 종료한다', () => {
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = ''
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    getConfig()

    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('WS_ALLOWED_ORIGINS가 공백/콤마뿐이면 fail-fast로 종료한다(refine)', () => {
    // 공백만·콤마만 → trim·filter 후 빈 배열 → .refine이 거부한다.
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = ' , '
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    getConfig()

    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('MONGODB_URI가 없으면 fail-fast로 종료한다', () => {
    delete process.env.MONGODB_URI
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    getConfig()

    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errorSpy).toHaveBeenCalled()
  })

  it('MONGODB_URI가 빈 문자열이면 fail-fast로 종료한다', () => {
    // 빈 문자열(.env의 MONGODB_URI= )은 z.string().min(1)에서 거부된다 — .default() 우회 방지.
    process.env.MONGODB_URI = ''
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    getConfig()

    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('연결 문자열 검증은 드라이버에 위임한다 — seed-list 복제셋 URI를 통과시킨다', () => {
    // z.url()이었다면 false-reject했을 유효한 다중 호스트 seed-list URI가 통과해야 한다.
    process.env.MONGODB_URI = 'mongodb://h1:27017,h2:27017/muhan_db_dev?replicaSet=rs0'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'

    const config = getConfig()

    expect(config.MONGODB_URI).toBe('mongodb://h1:27017,h2:27017/muhan_db_dev?replicaSet=rs0')
  })

  it('하트비트 env가 없으면 기본값을 채운다', () => {
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
    delete process.env.WS_HEARTBEAT_PING_INTERVAL_MS
    delete process.env.WS_HEARTBEAT_PONG_TIMEOUT_MS
    delete process.env.WS_HEARTBEAT_MAX_MISSED

    const config = getConfig()

    expect(config.WS_HEARTBEAT_PING_INTERVAL_MS).toBe(25000)
    expect(config.WS_HEARTBEAT_PONG_TIMEOUT_MS).toBe(10000)
    expect(config.WS_HEARTBEAT_MAX_MISSED).toBe(3)
  })

  it('하트비트 env 문자열을 숫자로 강제 변환한다', () => {
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
    process.env.WS_HEARTBEAT_PING_INTERVAL_MS = '5000'
    process.env.WS_HEARTBEAT_PONG_TIMEOUT_MS = '2000'
    process.env.WS_HEARTBEAT_MAX_MISSED = '5'

    const config = getConfig()

    expect(config.WS_HEARTBEAT_PING_INTERVAL_MS).toBe(5000)
    expect(config.WS_HEARTBEAT_PONG_TIMEOUT_MS).toBe(2000)
    expect(config.WS_HEARTBEAT_MAX_MISSED).toBe(5)
  })

  it('WS_HEARTBEAT_MAX_MISSED 하한(1) 미만이면 fail-fast로 종료한다', () => {
    // 임계가 0이면 첫 라운드에 즉시 terminate되어 하트비트가 무의미하므로 최소 1을 강제한다.
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
    process.env.WS_HEARTBEAT_MAX_MISSED = '0'
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    getConfig()

    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('WS_HEARTBEAT_PING_INTERVAL_MS가 하한(1) 미만이면 fail-fast로 종료한다', () => {
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
    process.env.WS_HEARTBEAT_PING_INTERVAL_MS = '0'
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    getConfig()

    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('WS_SESSION_DEADLINE_MS가 없으면 기본값(60000)을 채운다', () => {
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
    delete process.env.WS_SESSION_DEADLINE_MS

    const config = getConfig()

    expect(config.WS_SESSION_DEADLINE_MS).toBe(60000)
  })

  it('WS_SESSION_DEADLINE_MS 문자열을 숫자로 강제 변환한다', () => {
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
    process.env.WS_SESSION_DEADLINE_MS = '30000'

    const config = getConfig()

    expect(config.WS_SESSION_DEADLINE_MS).toBe(30000)
  })

  it('WS_SESSION_DEADLINE_MS가 하한(1) 미만이면 fail-fast로 종료한다', () => {
    // 데드라인이 0이면 진입 즉시 reap되어 진행 데드라인이 무의미하므로 최소 1을 강제한다.
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
    process.env.WS_SESSION_DEADLINE_MS = '0'
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    getConfig()

    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('WS_SESSION_DEADLINE_MS가 음수이면 fail-fast로 종료한다', () => {
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
    process.env.WS_SESSION_DEADLINE_MS = '-5'
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    getConfig()

    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('WS_SESSION_DEADLINE_MS가 비수치이면 fail-fast로 종료한다', () => {
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
    process.env.WS_SESSION_DEADLINE_MS = '십초'
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    getConfig()

    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('WS_RECONNECT_GRACE_MS가 없으면 기본값(30000)을 채운다', () => {
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
    delete process.env.WS_RECONNECT_GRACE_MS

    const config = getConfig()

    expect(config.WS_RECONNECT_GRACE_MS).toBe(30000)
  })

  it('WS_RECONNECT_GRACE_MS 문자열을 숫자로 강제 변환한다', () => {
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
    process.env.WS_RECONNECT_GRACE_MS = '5000'

    const config = getConfig()

    expect(config.WS_RECONNECT_GRACE_MS).toBe(5000)
  })

  it('WS_RECONNECT_GRACE_MS가 하한(1) 미만이면 fail-fast로 종료한다', () => {
    // grace가 0이면 link-dead 진입 즉시 만료돼 재연결 창이 무의미하므로 최소 1을 강제한다.
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
    process.env.WS_RECONNECT_GRACE_MS = '0'
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    getConfig()

    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('WS_RECONNECT_GRACE_MS가 비수치이면 fail-fast로 종료한다', () => {
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
    process.env.WS_RECONNECT_GRACE_MS = '삼십초'
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    getConfig()

    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('WS_IDLE_TIMEOUT_MS가 없으면 기본값(300000)을 채운다', () => {
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
    delete process.env.WS_IDLE_TIMEOUT_MS

    const config = getConfig()

    expect(config.WS_IDLE_TIMEOUT_MS).toBe(300000)
  })

  it('WS_IDLE_TIMEOUT_MS 문자열을 숫자로 강제 변환한다', () => {
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
    process.env.WS_IDLE_TIMEOUT_MS = '120000'

    const config = getConfig()

    expect(config.WS_IDLE_TIMEOUT_MS).toBe(120000)
  })

  it('WS_IDLE_TIMEOUT_MS가 하한(1) 미만이면 fail-fast로 종료한다', () => {
    // idle이 0이면 월드 진입 즉시 만료돼 무입력 감시가 무의미하므로 최소 1을 강제한다.
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
    process.env.WS_IDLE_TIMEOUT_MS = '0'
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    getConfig()

    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('WS_IDLE_TIMEOUT_MS가 음수이면 fail-fast로 종료한다', () => {
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
    process.env.WS_IDLE_TIMEOUT_MS = '-5'
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    getConfig()

    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('WS_IDLE_TIMEOUT_MS가 비수치이면 fail-fast로 종료한다', () => {
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
    process.env.WS_IDLE_TIMEOUT_MS = '오분'
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    getConfig()

    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('DEV_LOGIN_ENABLED가 없으면 false(boolean)를 기본값으로 채운다', () => {
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
    delete process.env.DEV_LOGIN_ENABLED

    const config = getConfig()

    expect(config.DEV_LOGIN_ENABLED).toBe(false)
  })

  it('DEV_LOGIN_ENABLED="true"를 boolean true로 파싱한다', () => {
    // NODE_ENV를 명시해 ambient 값(vitest 기본 test) 의존을 제거한다 — fail-closed 게이트가
    // dev/test 밖에서 DEV_LOGIN_ENABLED=true를 차단하므로, 이 파싱 테스트는 development로 고정한다.
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
    process.env.NODE_ENV = 'development'
    process.env.DEV_LOGIN_ENABLED = 'true'

    const config = getConfig()

    expect(config.DEV_LOGIN_ENABLED).toBe(true)
  })

  it('DEV_LOGIN_ENABLED="false" 문자열을 true로 강제하지 않는다(z.coerce.boolean 금지)', () => {
    // z.coerce.boolean은 비어있지 않은 문자열 "false"를 true로 강제한다 — enum+transform으로 회피.
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
    process.env.DEV_LOGIN_ENABLED = 'false'

    const config = getConfig()

    expect(config.DEV_LOGIN_ENABLED).toBe(false)
  })

  it('DEV_LOGIN_ENABLED가 허용되지 않은 값이면 fail-fast로 종료한다', () => {
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
    process.env.DEV_LOGIN_ENABLED = 'yes'
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    getConfig()

    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('WS_MAX_CONNECTIONS가 없으면 기본값(1000)을 채운다', () => {
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
    delete process.env.WS_MAX_CONNECTIONS

    const config = getConfig()

    expect(config.WS_MAX_CONNECTIONS).toBe(1000)
  })

  it('WS_MAX_CONNECTIONS 문자열을 숫자로 강제 변환한다', () => {
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
    process.env.WS_MAX_CONNECTIONS = '2000'

    const config = getConfig()

    expect(config.WS_MAX_CONNECTIONS).toBe(2000)
  })

  it('WS_MAX_CONNECTIONS가 하한(1) 미만이면 fail-fast로 종료한다', () => {
    // 정원이 0이면 어떤 연결도 수용 못 해 서버가 무의미하므로 최소 1을 강제한다.
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
    process.env.WS_MAX_CONNECTIONS = '0'
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    getConfig()

    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('NODE_ENV=production && DEV_LOGIN_ENABLED=true 조합이면 fail-fast로 종료한다', () => {
    // 인증 우회 2차 방어선 — 프로덕션에서 dev 로그인 활성화를 코드 레벨로 차단한다.
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
    process.env.NODE_ENV = 'production'
    process.env.DEV_LOGIN_ENABLED = 'true'
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    getConfig()

    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errorSpy).toHaveBeenCalled()
  })

  it('NODE_ENV 미설정 && DEV_LOGIN_ENABLED=true 조합이면 fail-fast로 종료한다(fail-closed)', () => {
    // 핵심 회귀: NODE_ENV 기본값(development)을 두면 미설정 배포에서 dev 로그인이 fail-open으로
    // 허용된다. NODE_ENV가 명시적 development/test가 아니면(미설정 포함) 차단해야 한다.
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
    delete process.env.NODE_ENV
    process.env.DEV_LOGIN_ENABLED = 'true'
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    getConfig()

    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errorSpy).toHaveBeenCalled()
  })

  it('NODE_ENV=staging 같은 비-dev 값 && DEV_LOGIN_ENABLED=true면 fail-fast로 종료한다', () => {
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
    process.env.NODE_ENV = 'staging'
    process.env.DEV_LOGIN_ENABLED = 'true'
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    getConfig()

    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('WS_MAX_CONNECTIONS가 음수이면 fail-fast로 종료한다', () => {
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
    process.env.WS_MAX_CONNECTIONS = '-5'
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    getConfig()

    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('NODE_ENV=production 이어도 DEV_LOGIN_ENABLED=false면 통과한다', () => {
    // dev 로그인 off면 임의 NODE_ENV로 서버가 crash하지 않는다.
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
    process.env.NODE_ENV = 'production'
    process.env.DEV_LOGIN_ENABLED = 'false'

    const config = getConfig()

    expect(config.DEV_LOGIN_ENABLED).toBe(false)
    expect(config.NODE_ENV).toBe('production')
  })

  it('NODE_ENV=development && DEV_LOGIN_ENABLED=true면 통과한다', () => {
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
    process.env.NODE_ENV = 'development'
    process.env.DEV_LOGIN_ENABLED = 'true'

    const config = getConfig()

    expect(config.DEV_LOGIN_ENABLED).toBe(true)
  })

  it('DEV_SEED_COOKIE·DEV_SEED_ACCOUNT_ID가 없으면 빈 문자열 기본값을 채운다', () => {
    // 플래그 off일 때도 파싱이 실패하지 않도록 시드 필드는 빈 문자열 default를 갖는다.
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
    delete process.env.DEV_SEED_COOKIE
    delete process.env.DEV_SEED_ACCOUNT_ID

    const config = getConfig()

    expect(config.DEV_SEED_COOKIE).toBe('')
    expect(config.DEV_SEED_ACCOUNT_ID).toBe('')
  })

  it('DEV_SEED_COOKIE·DEV_SEED_ACCOUNT_ID 값을 그대로 통과시킨다', () => {
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
    process.env.DEV_SEED_COOKIE = 'dev-seed-cookie-value'
    process.env.DEV_SEED_ACCOUNT_ID = 'dev-account-1'

    const config = getConfig()

    expect(config.DEV_SEED_COOKIE).toBe('dev-seed-cookie-value')
    expect(config.DEV_SEED_ACCOUNT_ID).toBe('dev-account-1')
  })

  it('WS_MAX_CONNECTIONS가 비수치이면 fail-fast로 종료한다', () => {
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
    process.env.WS_MAX_CONNECTIONS = '천개'
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    getConfig()

    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('WS_MAX_CONNECTIONS_PER_ACCOUNT가 없으면 기본값(5)을 채운다', () => {
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
    delete process.env.WS_MAX_CONNECTIONS_PER_ACCOUNT

    const config = getConfig()

    expect(config.WS_MAX_CONNECTIONS_PER_ACCOUNT).toBe(5)
  })

  it('WS_MAX_CONNECTIONS_PER_ACCOUNT 문자열을 숫자로 강제 변환한다', () => {
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
    process.env.WS_MAX_CONNECTIONS_PER_ACCOUNT = '10'

    const config = getConfig()

    expect(config.WS_MAX_CONNECTIONS_PER_ACCOUNT).toBe(10)
  })

  it('WS_MAX_CONNECTIONS_PER_ACCOUNT가 하한(1) 미만이면 fail-fast로 종료한다', () => {
    // 계정별 정원이 0이면 어떤 계정도 접속 못 해 무의미하므로 최소 1을 강제한다.
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
    process.env.WS_MAX_CONNECTIONS_PER_ACCOUNT = '0'
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    getConfig()

    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('WS_MAX_CONNECTIONS_PER_ACCOUNT가 음수이면 fail-fast로 종료한다', () => {
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
    process.env.WS_MAX_CONNECTIONS_PER_ACCOUNT = '-5'
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    getConfig()

    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('WS_MAX_CONNECTIONS_PER_ACCOUNT가 비수치이면 fail-fast로 종료한다', () => {
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
    process.env.WS_MAX_CONNECTIONS_PER_ACCOUNT = '다섯개'
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    getConfig()

    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('WS_MAX_BUFFERED_BYTES가 없으면 기본값(1048576)을 채운다', () => {
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
    delete process.env.WS_MAX_BUFFERED_BYTES

    const config = getConfig()

    expect(config.WS_MAX_BUFFERED_BYTES).toBe(1048576)
  })

  it('WS_MAX_BUFFERED_BYTES 문자열을 숫자로 강제 변환한다', () => {
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
    process.env.WS_MAX_BUFFERED_BYTES = '2097152'

    const config = getConfig()

    expect(config.WS_MAX_BUFFERED_BYTES).toBe(2097152)
  })

  it('WS_MAX_BUFFERED_BYTES가 하한(1) 미만이면 fail-fast로 종료한다', () => {
    // 상한이 0이면 어떤 아웃바운드도 즉시 초과로 판정돼 무의미하므로 최소 1을 강제한다.
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
    process.env.WS_MAX_BUFFERED_BYTES = '0'
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    getConfig()

    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('WS_MAX_BUFFERED_BYTES가 음수이면 fail-fast로 종료한다', () => {
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
    process.env.WS_MAX_BUFFERED_BYTES = '-5'
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    getConfig()

    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('WS_MAX_BUFFERED_BYTES가 비수치이면 fail-fast로 종료한다', () => {
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
    process.env.WS_MAX_BUFFERED_BYTES = '일메가'
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    getConfig()

    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('WS_MSG_RATE_* 미설정이면 기본값(20/10/40/20/10)을 채운다', () => {
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
    delete process.env.WS_MSG_RATE_CAPACITY
    delete process.env.WS_MSG_RATE_REFILL_PER_SEC
    delete process.env.WS_MSG_RATE_ACCOUNT_CAPACITY
    delete process.env.WS_MSG_RATE_ACCOUNT_REFILL_PER_SEC
    delete process.env.WS_MSG_RATE_MAX_VIOLATIONS

    const config = getConfig()

    expect(config.WS_MSG_RATE_CAPACITY).toBe(20)
    expect(config.WS_MSG_RATE_REFILL_PER_SEC).toBe(10)
    expect(config.WS_MSG_RATE_ACCOUNT_CAPACITY).toBe(40)
    expect(config.WS_MSG_RATE_ACCOUNT_REFILL_PER_SEC).toBe(20)
    expect(config.WS_MSG_RATE_MAX_VIOLATIONS).toBe(10)
  })

  it('WS_MSG_RATE_CAPACITY 문자열을 숫자로 강제 변환한다', () => {
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
    process.env.WS_MSG_RATE_CAPACITY = '50'

    const config = getConfig()

    expect(config.WS_MSG_RATE_CAPACITY).toBe(50)
  })

  it.each([
    'WS_MSG_RATE_CAPACITY',
    'WS_MSG_RATE_REFILL_PER_SEC',
    'WS_MSG_RATE_ACCOUNT_CAPACITY',
    'WS_MSG_RATE_ACCOUNT_REFILL_PER_SEC',
    'WS_MSG_RATE_MAX_VIOLATIONS',
  ])('%s가 하한(1) 미만이면 fail-fast로 종료한다', (field) => {
    // 각 속도 상한 필드가 0이면 유량 회계가 무의미하므로 최소 1을 강제한다.
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
    process.env[field] = '0'
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    getConfig()

    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})
