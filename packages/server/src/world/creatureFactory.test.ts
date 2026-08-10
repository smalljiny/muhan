import { describe, it, expect } from 'vitest'
import {
  fromEmbedded,
  fromTemplate,
  defaultCreatureRng,
  type CreatureSource,
} from './creatureFactory.js'

// 방 embedded 좀도둑(r00135 검증값) 형태의 raw 소스.
const thief: CreatureSource = {
  name: '좀도둑',
  level: 4,
  hpmax: 7,
  mpmax: 0,
  dexterity: 14,
  gold: 80,
  special: 0,
  flags: '0112000000000000',
  armor: 90,
  thaco: 17,
  ndice: 1,
  sdice: 5,
  pdice: 0,
  // 마법 시전 읽기 필드(Story 2, spec §3.x): spells hex(주문 비트셋)·class·intelligence·piety.
  // realm은 소스에 없어 CreatureSource에 포함하지 않는다(materialize가 [0,0,0,0] 기본값 설정).
  spells: 'ff00000000000000000000000000000a',
  class: 2,
  intelligence: 18,
  piety: 12,
  // 사망 분배 읽기 필드(Story 6): experience(킬 경험치)·alignment(정렬, 선/악 축 — 음수 유효).
  experience: 300,
  alignment: -50,
}

describe('fromEmbedded', () => {
  it('embedded 데이터로 라이브 인스턴스를 물질화하고 templateId=null이다', () => {
    const c = fromEmbedded(thief, 135, 0)
    expect(c.templateId).toBeNull()
    expect(c.name).toBe('좀도둑')
    expect(c.level).toBe(4)
    expect(c.hpmax).toBe(7)
    expect(c.dexterity).toBe(14)
    expect(c.flags).toBe('0112000000000000')
  })

  it('instanceId는 결정적 `${roomId}:c${idx}`이다', () => {
    expect(fromEmbedded(thief, 135, 0).instanceId).toBe('135:c0')
    expect(fromEmbedded(thief, 135, 1).instanceId).toBe('135:c1')
  })

  it('hpcur=hpmax·mpcur=mpmax 초기값이고 enemies는 빈 배열이다', () => {
    const c = fromEmbedded(thief, 135, 0)
    expect(c.hpcur).toBe(c.hpmax)
    expect(c.mpcur).toBe(c.mpmax)
    expect(c.enemies).toEqual([])
  })

  it('전투 스탯 armor/thaco/ndice/sdice/pdice를 소스에서 물질화한다(D6)', () => {
    const c = fromEmbedded(thief, 135, 0)
    expect(c.armor).toBe(90)
    expect(c.thaco).toBe(17)
    expect(c.ndice).toBe(1)
    expect(c.sdice).toBe(5)
    expect(c.pdice).toBe(0)
  })

  it('마법 읽기 필드 spells/class/intelligence/piety를 소스에서 물질화한다(Story 2)', () => {
    const c = fromEmbedded(thief, 135, 0)
    expect(c.spells).toBe('ff00000000000000000000000000000a')
    expect(c.class).toBe(2)
    expect(c.intelligence).toBe(18)
    expect(c.piety).toBe(12)
  })

  it('사망 분배 읽기 필드 experience/alignment를 소스에서 물질화한다(Story 6, Story 7 입력)', () => {
    const c = fromEmbedded(thief, 135, 0)
    expect(c.experience).toBe(300)
    expect(c.alignment).toBe(-50)
  })

  it('별칭 keys를 소스에서 물질화한다(Story 4 embedded 경로)', () => {
    const named: CreatureSource = { ...thief, keys: ['좀도둑', '도둑'] }
    expect(fromEmbedded(named, 135, 0).keys).toEqual(['좀도둑', '도둑'])
  })

  it('소스에 keys가 없으면 빈 배열이다(undefined 아님 — 매처 분기 방지)', () => {
    // thief 픽스처는 keys를 갖지 않는다. 정본 JSON은 별칭 없는 크리처도 []를 실어 이 분기를
    // 타지 않으므로, `?? []` 계약은 이 합성 소스가 유일한 방어선이다.
    expect(fromEmbedded(thief, 135, 0).keys).toEqual([])
  })

  it('keys는 소스와 독립 배열이다(공유 참조 aliasing 없음 — realm 선례)', () => {
    // 같은 템플릿에서 스폰된 전 인스턴스가 인덱스 엔트리의 배열 하나를 공유하면, 향후 별칭
    // 변형이 템플릿과 전 스폰을 동시에 오염시킨다. 값 동등(toEqual)만으론 못 잡으므로 참조를 고정한다.
    const src: CreatureSource = { ...thief, keys: ['좀도둑'] }
    const a = fromEmbedded(src, 135, 0)
    expect(a.keys).not.toBe(src.keys)
    expect(a.keys).not.toBe(fromEmbedded(src, 135, 1).keys)
  })

  it('realm은 소스에 없어 [0,0,0,0] 상수 기본값으로 설정한다(전 몬스터 realm=0, #85 소관)', () => {
    const c = fromEmbedded(thief, 135, 0)
    expect(c.realm).toEqual([0, 0, 0, 0])
  })

  it('realm은 인스턴스마다 독립 배열이다(공유 참조 aliasing 없음 — #85 성장 write 오염 방지)', () => {
    // toEqual 값 동등만으론 모듈 레벨 공유 const 리팩터링을 못 잡는다. #85가 한 인스턴스 realm을
    // in-place 성장 write할 때 다른 인스턴스로 번지지 않도록 참조 구별을 고정한다(Story 2 핵심 속성).
    const a = fromEmbedded(thief, 135, 0)
    const b = fromEmbedded(thief, 135, 1)
    expect(a.realm).not.toBe(b.realm)
  })

  it('기본 rng stub은 gold를 그대로 둔다(결정적 identity)', () => {
    expect(fromEmbedded(thief, 135, 0).gold).toBe(80)
    expect(defaultCreatureRng(80)).toBe(80)
  })

  it('주입 rng seam이 carry/gold 랜덤화에 사용된다', () => {
    const halveGold = (base: number) => Math.floor(base / 2)
    expect(fromEmbedded(thief, 135, 0, halveGold).gold).toBe(40)
  })

  it('같은 입력에 같은 인스턴스(Math.random/Date.now 미사용)', () => {
    expect(fromEmbedded(thief, 135, 0)).toEqual(fromEmbedded(thief, 135, 0))
  })
})

describe('fromTemplate', () => {
  const byId = new Map<number, CreatureSource>([[123, thief]])

  it('creatures.json을 id로 조회해 물질화하고 templateId=조회 id다', () => {
    const c = fromTemplate(123, 200, 0, defaultCreatureRng, byId)
    expect(c).toBeDefined()
    expect(c?.templateId).toBe(123)
    expect(c?.name).toBe('좀도둑')
    expect(c?.instanceId).toBe('200:c0')
    expect(c?.hpcur).toBe(7)
    // 전투 스탯도 템플릿 소스에서 물질화된다(embedded는 templateId=null이라 재조회 불가 → 물질화 시점에 이동).
    expect(c?.armor).toBe(90)
    expect(c?.thaco).toBe(17)
    expect(c?.ndice).toBe(1)
    expect(c?.sdice).toBe(5)
    expect(c?.pdice).toBe(0)
    // 마법 읽기 필드도 템플릿 소스에서 물질화되고 realm은 기본값 [0,0,0,0]이다.
    expect(c?.spells).toBe('ff00000000000000000000000000000a')
    expect(c?.class).toBe(2)
    expect(c?.intelligence).toBe(18)
    expect(c?.piety).toBe(12)
    expect(c?.realm).toEqual([0, 0, 0, 0])
    // 사망 분배 읽기 필드도 템플릿 소스에서 물질화된다(Story 6).
    expect(c?.experience).toBe(300)
    expect(c?.alignment).toBe(-50)
  })

  it('별칭 keys를 템플릿 소스에서 물질화한다(Story 4 템플릿 경로)', () => {
    const named = new Map<number, CreatureSource>([[7, { ...thief, keys: ['좀도둑'] }]])
    expect(fromTemplate(7, 200, 0, defaultCreatureRng, named)?.keys).toEqual(['좀도둑'])
  })

  it('알 수 없는 templateId면 undefined를 반환한다', () => {
    expect(fromTemplate(999, 200, 0, defaultCreatureRng, byId)).toBeUndefined()
  })

  it('주입 rng seam이 gold에 적용된다', () => {
    const zeroGold = () => 0
    expect(fromTemplate(123, 200, 0, zeroGold, byId)?.gold).toBe(0)
  })
})
