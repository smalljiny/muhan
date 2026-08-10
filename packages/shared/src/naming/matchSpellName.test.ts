import { describe, it, expect } from 'vitest'
import { matchSpellName, type SpellNameMatch } from './matchSpellName.js'
import { SPELL_CATALOG, SPELL_NO } from '../magic/catalog.js'

/**
 * 오라클 주문명 매칭 회귀 픽스처 — `magic1.c:49-70`.
 *
 * ```c
 * do {
 *     if(!strcmp(cmnd->str[1], spllist[c].splstr)) { match = 1; splno = c; break; }
 *     else if(!strncmp(cmnd->str[1], spllist[c].splstr, strlen(cmnd->str[1]))) {
 *         match++; splno = c;
 *     }
 *     c++;
 * } while(spllist[c].splno != -1);
 * ```
 *
 * 완전일치는 누적을 1로 **리셋하고 즉시 break** — 선언 순서와 무관하게 이긴다.
 * match === 0 → 부재, match > 1 → 모호 거부.
 */

type Entry = { spellNo: number; koreanName: string }

/**
 * 완전일치 우선을 판별하는 합성 픽스처 — 한쪽이 다른 쪽의 **진접두**인 쌍.
 * 실제 카탈로그 56개에는 이런 쌍이 없어(`은둔`은 주문명이 아니다) 합성으로 만든다.
 * 이 쌍이 없으면 완전일치 리셋·break를 제거해도 테스트가 통과해버린다.
 */
const PREFIX_PAIR: readonly Entry[] = [
  { spellNo: 1, koreanName: '불꽃' },
  { spellNo: 2, koreanName: '불꽃놀이' },
]

describe('matchSpellName — 은둔 계열 회귀 (완료 기준 1)', () => {
  it('`은둔`은 두 건 접두 일치라 모호 거부한다', () => {
    expect(matchSpellName(SPELL_CATALOG, '은둔')).toEqual({ kind: 'ambiguous' })
  })

  it('`은둔법`은 SINVIS로 확정된다', () => {
    expect(matchSpellName(SPELL_CATALOG, '은둔법')).toEqual({
      kind: 'found',
      spellNo: SPELL_NO.SINVIS,
    })
  })

  it('`은둔감지술`은 SDINVI로 확정된다', () => {
    expect(matchSpellName(SPELL_CATALOG, '은둔감지술')).toEqual({
      kind: 'found',
      spellNo: SPELL_NO.SDINVI,
    })
  })

  it('카탈로그에 없는 문자열은 못 찾음이다', () => {
    expect(matchSpellName(SPELL_CATALOG, '없는주문이름')).toEqual({ kind: 'notFound' })
  })
})

describe('matchSpellName — 완전일치 우선 (완료 기준 2)', () => {
  it('완전일치가 진접두 형제보다 먼저 선언돼도 확정된다', () => {
    expect(matchSpellName(PREFIX_PAIR, '불꽃')).toEqual({ kind: 'found', spellNo: 1 })
  })

  it('완전일치가 진접두 형제보다 뒤에 선언돼도 확정된다 (선언 순서 무관)', () => {
    const reversed = [...PREFIX_PAIR].reverse()

    // 리셋이 없으면 앞선 '불꽃놀이'의 접두 누적이 남아 match === 2 → 모호가 된다.
    expect(matchSpellName(reversed, '불꽃')).toEqual({ kind: 'found', spellNo: 1 })
  })

  // 위 PREFIX_PAIR 케이스가 완전일치 우선을 실제로 lock한다. 아래 실카탈로그 역순 케이스는
  // 현재 판별력이 없다 — 56개 주문명에 진접두 쌍이 0건이라 리셋·break 유무와 무관하게 통과한다.
  // 그 전제를 침묵시키지 않고 트립와이어로 고정한다: 카탈로그에 진접두 쌍이 생기는 순간 이
  // 단정이 깨지고, 바로 그 시점이 역순 케이스가 의미를 갖기 시작하는 시점이다.
  it('실카탈로그에는 진접두 쌍이 없다 (아래 역순 케이스의 판별력 전제)', () => {
    const names = SPELL_CATALOG.map((e) => e.koreanName)
    const properPrefixPairs = names.flatMap((a) =>
      names.filter((b) => b !== a && b.startsWith(a)).map((b) => `${a} ⊏ ${b}`),
    )
    expect(properPrefixPairs).toEqual([])
    expect(new Set(names).size).toBe(names.length) // 동명 중복도 0건
  })

  it('카탈로그 순서를 뒤집어도 `은둔법`이 SINVIS로 확정된다', () => {
    const reversed = [...SPELL_CATALOG].reverse()

    expect(matchSpellName(reversed, '은둔법')).toEqual({
      kind: 'found',
      spellNo: SPELL_NO.SINVIS,
    })
    expect(matchSpellName(reversed, '은둔감지술')).toEqual({
      kind: 'found',
      spellNo: SPELL_NO.SDINVI,
    })
    expect(matchSpellName(reversed, '은둔')).toEqual({ kind: 'ambiguous' })
  })

  it('완전일치는 즉시 종료한다 — 동명 중복이면 첫 엔트리가 이긴다', () => {
    const dupes: readonly Entry[] = [
      { spellNo: 7, koreanName: '치료술' },
      { spellNo: 8, koreanName: '치료술' },
    ]

    expect(matchSpellName(dupes, '치료술')).toEqual({ kind: 'found', spellNo: 7 })
  })
})

describe('matchSpellName — 유일 접두 확정', () => {
  it('접두 일치가 하나뿐이면 확정된다', () => {
    expect(matchSpellName(PREFIX_PAIR, '불꽃놀')).toEqual({ kind: 'found', spellNo: 2 })
  })

  it('접두 일치가 둘 이상이면 모호 거부한다', () => {
    expect(matchSpellName(PREFIX_PAIR, '불')).toEqual({ kind: 'ambiguous' })
  })
})

describe('matchSpellName — 경계 케이스', () => {
  it('엔트리 배열이 비면 못 찾음이다', () => {
    expect(matchSpellName([], '은둔법')).toEqual({ kind: 'notFound' })
  })

  it('빈 문자열 query는 전 엔트리에 접두 일치해 모호 거부한다', () => {
    // strncmp(a,b,0) === 0 — 거부 게이트를 넣지 않고 오라클 동작을 그대로 둔다.
    expect(matchSpellName(SPELL_CATALOG, '')).toEqual({ kind: 'ambiguous' })
  })

  it('엔트리가 하나뿐이면 빈 문자열 query도 확정된다', () => {
    expect(matchSpellName([{ spellNo: 3, koreanName: '치료술' }], '')).toEqual({
      kind: 'found',
      spellNo: 3,
    })
  })

  it('query가 주문명보다 길면 못 찾음이다', () => {
    expect(matchSpellName([{ spellNo: 3, koreanName: '치료술' }], '치료술사')).toEqual({
      kind: 'notFound',
    })
  })

  it('판별 유니온은 kind 태그로 좁혀진다', () => {
    const result: SpellNameMatch = matchSpellName(SPELL_CATALOG, '은둔법')

    if (result.kind === 'found') {
      expect(result.spellNo).toBe(SPELL_NO.SINVIS)
    } else {
      expect.unreachable('은둔법은 완전일치라 확정돼야 한다')
    }
  })
})

describe('matchSpellName — 순수성 (완료 기준 8)', () => {
  it('입력 배열·객체를 변형하지 않는다', () => {
    const entries: Entry[] = [
      { spellNo: 1, koreanName: '불꽃' },
      { spellNo: 2, koreanName: '불꽃놀이' },
    ]
    const before = structuredClone(entries)

    matchSpellName(entries, '불꽃')
    matchSpellName(entries, '불')
    matchSpellName(entries, '없음')

    expect(entries).toStrictEqual(before)
  })

  it('SPELL_CATALOG를 변형하지 않는다', () => {
    const before = structuredClone(SPELL_CATALOG)

    matchSpellName(SPELL_CATALOG, '은둔')
    matchSpellName(SPELL_CATALOG, '은둔법')

    expect(SPELL_CATALOG).toStrictEqual(before)
  })

  it('동일 입력에 동일 출력을 낸다 (전역 상태 미참조)', () => {
    expect(matchSpellName(SPELL_CATALOG, '은둔법')).toEqual(matchSpellName(SPELL_CATALOG, '은둔법'))
  })
})
