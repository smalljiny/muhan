import { describe, it, expect } from 'vitest'
import {
  createDevSeedAuthAdapter,
  createDevSeedAuthAdapterFromEnv,
  DEV_SEED_CHARACTER,
} from './devSeedSessionAuth.js'

describe('createDevSeedAuthAdapter', () => {
  it('시드 쿠키를 DEV_SEED_ACCOUNT_ID로 검증하는 어댑터를 조립한다', async () => {
    const adapter = createDevSeedAuthAdapter('dev-cookie', 'dev-account-1')

    expect(await adapter.validateSessionCookie('dev-cookie')).toEqual({ accountId: 'dev-account-1' })
  })

  it('알 수 없는 쿠키는 null을 반환한다(유효 쿠키는 시드 쿠키 1개뿐)', async () => {
    const adapter = createDevSeedAuthAdapter('dev-cookie', 'dev-account-1')

    expect(await adapter.validateSessionCookie('other-cookie')).toBeNull()
  })

  it('시드 account에 고정 캐릭터 1개를 심는다', async () => {
    const adapter = createDevSeedAuthAdapter('dev-cookie', 'dev-account-1')

    const chars = await adapter.listCharacters('dev-account-1')
    expect(chars).toHaveLength(1)
    expect(chars[0]).toEqual(DEV_SEED_CHARACTER)
  })

  it('쿠키가 빈 문자열이면 조립을 거부한다(fail-fast)', () => {
    expect(() => createDevSeedAuthAdapter('', 'dev-account-1')).toThrow()
  })

  it('accountId가 빈 문자열이면 조립을 거부한다(fail-fast)', () => {
    expect(() => createDevSeedAuthAdapter('dev-cookie', '')).toThrow()
  })
})

describe('createDevSeedAuthAdapterFromEnv', () => {
  it('env 값에서 시드 쿠키·계정을 읽어 어댑터를 조립한다', async () => {
    const adapter = createDevSeedAuthAdapterFromEnv({
      DEV_SEED_COOKIE: 'env-cookie',
      DEV_SEED_ACCOUNT_ID: 'env-account',
    })

    expect(await adapter.validateSessionCookie('env-cookie')).toEqual({ accountId: 'env-account' })
  })

  it('env 시드 값이 비면 조립을 거부한다(fail-fast)', () => {
    expect(() =>
      createDevSeedAuthAdapterFromEnv({ DEV_SEED_COOKIE: '', DEV_SEED_ACCOUNT_ID: '' }),
    ).toThrow()
  })
})
