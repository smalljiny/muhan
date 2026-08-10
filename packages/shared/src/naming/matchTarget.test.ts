import { describe, it, expect } from 'vitest'
import { matchTarget } from './matchTarget.js'
import type { CreatureInstance } from '../worldGraph.js'

/**
 * 오라클 `EQUAL`(mtype.h:579) 회귀 픽스처.
 *
 * ```c
 * #define EQUAL(a,b)  ((a) && (b) && \
 *                      (!strncmp((a)->name,(b),strlen(b)) || \
 *                       !strncmp((a)->key[0],(b),strlen(b)) || \
 *                       !strncmp((a)->key[1],(b),strlen(b)) || \
 *                       !strncmp((a)->key[2],(b),strlen(b))))
 * ```
 *
 * 순수 접두 4필드 검사 + 서수 선택. 완전일치 특례·모호 거부·가시성 게이트가 **없다**.
 */

type Candidate = { name: string; keys?: readonly string[] }

describe('matchTarget — keys 접두 매칭 (완료 기준 4)', () => {
  it('name이 아니라 keys로만 일치하는 후보를 찾는다', () => {
    const candidates: Candidate[] = [{ name: '작은 거미', keys: ['거미'] }]

    // '작은 거미'는 '거미'로 시작하지 않는다 — keys 검사가 없으면 못 찾는다.
    expect(matchTarget(candidates, '거미')).toBe(candidates[0])
  })

  it('keys 없는 동일 name 후보에는 undefined를 반환한다 (순수 접두 증명)', () => {
    const candidates: Candidate[] = [{ name: '작은 거미' }]

    expect(matchTarget(candidates, '거미')).toBeUndefined()
  })

  it('key[0..2] 세 슬롯 전부를 검사한다', () => {
    const third: Candidate = { name: '이름', keys: ['가', '나', '다'] }

    expect(matchTarget([third], '가')).toBe(third)
    expect(matchTarget([third], '나')).toBe(third)
    expect(matchTarget([third], '다')).toBe(third)
  })

  it('keys 미보유(undefined) 후보도 name 단독으로 매칭된다 (완료 기준 6)', () => {
    const player: Candidate = { name: '타이' }

    expect(matchTarget([player], '타')).toBe(player)
    expect(matchTarget([player], '타이')).toBe(player)
  })

  it('keys가 빈 배열이면 name만 검사한다', () => {
    const candidate: Candidate = { name: '작은 거미', keys: [] }

    expect(matchTarget([candidate], '작은')).toBe(candidate)
    expect(matchTarget([candidate], '거미')).toBeUndefined()
  })
})

describe('matchTarget — 서수 선택 (완료 기준 5)', () => {
  const trio: Candidate[] = [
    { name: '고블린', keys: ['잡졸'] },
    { name: '고블린', keys: ['잡졸'] },
    { name: '고블린', keys: ['잡졸'] },
  ]

  it('ordinal 기본값 1은 첫째 후보를 반환한다', () => {
    expect(matchTarget(trio, '고블린')).toBe(trio[0])
  })

  it('ordinal=2는 둘째 후보를 반환한다 (모호 거부 없음)', () => {
    expect(matchTarget(trio, '고블린', 2)).toBe(trio[1])
  })

  it('ordinal=3은 셋째 후보를 반환한다', () => {
    expect(matchTarget(trio, '고블린', 3)).toBe(trio[2])
  })

  it('ordinal이 매치 수를 초과하면 undefined를 반환한다', () => {
    expect(matchTarget(trio, '고블린', 4)).toBeUndefined()
  })

  it('ordinal=0·음수는 어떤 후보와도 확정되지 않는다', () => {
    // C 관례: match++ 후 match === num 비교 — 카운터는 1부터 시작하므로 0 이하는 미달이다.
    expect(matchTarget(trio, '고블린', 0)).toBeUndefined()
    expect(matchTarget(trio, '고블린', -1)).toBeUndefined()
  })

  it('서수는 매치한 후보만 센다 — 비매치 후보는 카운터를 올리지 않는다', () => {
    const mixed: Candidate[] = [{ name: '늑대' }, { name: '고블린' }, { name: '고블린' }]

    expect(matchTarget(mixed, '고블린', 1)).toBe(mixed[1])
    expect(matchTarget(mixed, '고블린', 2)).toBe(mixed[2])
  })
})

describe('matchTarget — 완전일치 특례 없음', () => {
  it('완전일치 후보가 뒤에 있어도 접두 일치한 앞 후보가 이긴다', () => {
    const candidates: Candidate[] = [{ name: '검광선' }, { name: '검' }]

    // 주문명 매처와 달리 EQUAL에는 완전일치 리셋·break가 없다 — 선언 순서가 그대로 서수다.
    expect(matchTarget(candidates, '검')).toBe(candidates[0])
    expect(matchTarget(candidates, '검', 2)).toBe(candidates[1])
  })
})

describe('matchTarget — 경계 케이스', () => {
  it('후보 배열이 비면 undefined를 반환한다', () => {
    expect(matchTarget([], '고블린')).toBeUndefined()
  })

  it('빈 문자열 query는 모든 후보에 매치한다 (strncmp(a,b,0) === 0)', () => {
    const candidates: Candidate[] = [{ name: '늑대' }, { name: '고블린' }]

    // 거부 게이트를 넣지 않는다 — 빈 query·1음절 거부는 해소자(#121) 소관이다.
    expect(matchTarget(candidates, '')).toBe(candidates[0])
    expect(matchTarget(candidates, '', 2)).toBe(candidates[1])
  })

  it('query가 name보다 길면 매치하지 않는다', () => {
    expect(matchTarget([{ name: '늑대' }], '늑대인간')).toBeUndefined()
  })

  it('완전히 같은 문자열은 자기 자신의 접두이므로 매치한다', () => {
    const candidate: Candidate = { name: '늑대' }

    expect(matchTarget([candidate], '늑대')).toBe(candidate)
  })
})

describe('matchTarget — 소비자 타입 계약', () => {
  it('CreatureInstance(keys?: string[] — 가변)를 그대로 후보로 받는다', () => {
    // 스펙 §3.1 "타입 무관 — { name, keys? } 형상만 본다". readonly 제약이 Story 6 해소자의
    // 실소비 타입을 거르면 여기서 컴파일이 깨진다.
    const creature = { name: '작은 거미', keys: ['거미'] } as unknown as CreatureInstance
    const candidates: CreatureInstance[] = [creature]

    const found: CreatureInstance | undefined = matchTarget(candidates, '거미')
    expect(found).toBe(creature)
  })
})

describe('matchTarget — 순수성 (완료 기준 8)', () => {
  it('입력 배열·객체를 변형하지 않는다', () => {
    const candidates: Candidate[] = [
      { name: '고블린', keys: ['잡졸'] },
      { name: '작은 거미', keys: ['거미'] },
    ]
    const before = structuredClone(candidates)

    matchTarget(candidates, '거미')
    matchTarget(candidates, '고', 1)
    matchTarget(candidates, '', 9)

    expect(candidates).toStrictEqual(before)
    expect(candidates).toHaveLength(2)
  })

  it('동일 입력에 동일 출력을 낸다 (전역 상태 미참조)', () => {
    const candidates: Candidate[] = [{ name: '고블린' }, { name: '고블린' }]

    expect(matchTarget(candidates, '고블린', 2)).toBe(matchTarget(candidates, '고블린', 2))
    expect(matchTarget(candidates, '고블린')).toBe(candidates[0])
  })

  it('반환값은 입력 객체 참조 그대로다 (복제하지 않는다)', () => {
    const candidate: Candidate = { name: '고블린' }

    expect(matchTarget([candidate], '고블린')).toBe(candidate)
  })
})
