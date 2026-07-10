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
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
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
})
