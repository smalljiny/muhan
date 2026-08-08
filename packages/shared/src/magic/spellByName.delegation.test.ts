import { describe, it, expect, vi, beforeEach } from 'vitest'

// 파일 스코프 hoist라 별도 파일에 둔다 — catalog.test.ts의 실동작 단정을 오염시키지 않는다.
//
// 이 파일은 `.harness/rules/testing.md`의 "비즈니스 로직 mock 금지" 원칙의 문서화된 예외다.
// 완료 기준 3은 구조적 속성(규칙 본체 미복제)이고, 행위가 동일한 복제본은 어떤 블랙박스
// 테스트로도 검출되지 않는다. subject(`spellByName`)는 자기 로직이 0줄이라 가려지는 것도 없다.
// 실동작 검증은 catalog.test.ts가 mock 없이 별도로 수행한다.
vi.mock('../naming/matchSpellName.js', () => ({
  matchSpellName: vi.fn(),
}))

import { matchSpellName } from '../naming/matchSpellName.js'
import { spellByName, SPELL_CATALOG } from './catalog.js'

/**
 * 완료 기준 3 — `spellByName`이 규칙 본체를 재구현하지 않고 `naming/matchSpellName`에 위임한다.
 *
 * "호출됐다"만 단정하면 결과를 무시하는 short-circuit 경로를 못 잡는다. 그래서 매처를
 * **오라클과 모순되는 sentinel**로 대체하고 그 sentinel이 그대로 나오는지 본다 —
 * catalog.ts에 완전일치 인덱스나 do-while 사본이 있으면 이 단정이 깨진다.
 */
describe('spellByName — 규칙 위임 (완료 기준 3)', () => {
  beforeEach(() => {
    vi.mocked(matchSpellName).mockReset()
  })

  it('SPELL_CATALOG와 query를 그대로 매처에 넘긴다', () => {
    vi.mocked(matchSpellName).mockReturnValue({ kind: 'notFound' })

    spellByName('은둔법')

    expect(matchSpellName).toHaveBeenCalledTimes(1)
    expect(matchSpellName).toHaveBeenCalledWith(SPELL_CATALOG, '은둔법')
  })

  it('완전일치 query에서도 매처 결과를 그대로 반환한다 (우회 경로 없음)', () => {
    // 오라클이라면 '은둔법'은 확정이다. sentinel이 새어 나오면 catalog가 우회 경로를 갖지 않는다는 증거다.
    vi.mocked(matchSpellName).mockReturnValue({ kind: 'ambiguous' })

    expect(spellByName('은둔법')).toEqual({ kind: 'ambiguous' })
  })

  it('확정·못 찾음 결과를 가공 없이 통과시킨다 (모호는 직전 케이스 소관)', () => {
    vi.mocked(matchSpellName).mockReturnValue({ kind: 'found', spellNo: 99 })
    expect(spellByName('아무거나')).toEqual({ kind: 'found', spellNo: 99 })

    vi.mocked(matchSpellName).mockReturnValue({ kind: 'notFound' })
    expect(spellByName('아무거나')).toEqual({ kind: 'notFound' })
  })
})
