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
    delete process.env.MONGODB_DB_NAME
    delete process.env.PORT

    const config = getConfig()

    expect(config.MONGODB_URI).toBe('mongodb://localhost:27017')
    expect(config.MONGODB_DB_NAME).toBe('muhan_db_dev')
    expect(config.PORT).toBe(3000)
  })

  it('PORT 환경변수를 숫자로 강제 변환한다', () => {
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.PORT = '8080'

    const config = getConfig()

    expect(config.PORT).toBe(8080)
  })

  it('두 번 호출하면 동일 인스턴스를 반환한다(싱글턴)', () => {
    process.env.MONGODB_URI = 'mongodb://localhost:27017'

    const first = getConfig()
    const second = getConfig()

    expect(first).toBe(second)
  })

  it('MONGODB_URI가 없으면 fail-fast로 종료한다', () => {
    delete process.env.MONGODB_URI
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

    const config = getConfig()

    expect(config.MONGODB_URI).toBe('mongodb://h1:27017,h2:27017/muhan_db_dev?replicaSet=rs0')
  })
})
