import type { GoldenFixture } from '../types.js'
import { makeManualFixture, writeFixtureFile } from './fixtureIo.js'
import { oracleMprofic } from './mproficFixture.js'

// 재생성 명령이 `import { buildFixture, writeFixtureFile }`로 소비하므로 writer를 re-export한다.
export { writeFixtureFile }

/**
 * offensive_spell 골든 전사-diff fixture 생성기 — manual oracle.
 *
 * 원본 `magic1.c:820-1170`의 공격 주문 데미지 파이프(bns·방상성·마법저항·오버킬 캡·사망)를 **독립
 * 리터럴**로 전사해(전사 pass 2) 자기완결 시나리오 케이스로 감싼다. SUT `offensiveSpell`(server/magic)은
 * offensiveSpell.ts 구현(전사 pass 1)을 소비하므로, approve가 두 전사의 불일치를 잡아낸다.
 *
 * bns의 mprofic 항은 `oracleMprofic`(mproficFixture.ts의 pass-2 전사)을 재사용한다 — server mprofic.ts를
 * import하지 않아 anti-tautology를 유지한다. 플래그 비트·realm 코드도 server 상수가 아닌 mtype.h 리터럴이다.
 *
 * ## gated 한정 상성(오라클 divergence 명시)
 * 오라클은 방 상성을 게이트 밖에서 적용하나 이 포트는 gated로 접는다(offensiveSpell.ts 주석 참조). 따라서
 * gated=false + 반대속성 조합은 fixture에 **넣지 않는다** — 그 -5 divergence를 영구 고정하지 않기 위함이다.
 *
 * SUT 소비 approve는 server가 소유한다(`packages/server/src/magic/offensiveSpell.test.ts`) — shared는 server를
 * import 못 하므로, 이 파일은 fixture만 생성하고 approve는 server 테스트가 디스크 json을 읽어 실행한다.
 *
 * ## 재생성 (수동 트리거)
 * ```
 * cd packages/shared
 * node ../server/node_modules/tsx/dist/cli.mjs --eval "import { buildFixture, writeFixtureFile } from './src/oracle/generators/offensiveSpellFixture.ts'; writeFixtureFile('./src/oracle/fixtures/offensive_spell.json', buildFixture(() => new Date('2026-07-16T00:00:00.000Z')))"
 * ```
 */

// realm 코드(mtype.h:142-145). 방 상성 플래그(mtype.h:320-323). MRMAGI(mtype.h:438).
const R_EARTH = 1
const R_WIND = 2
const R_FIRE = 3
const R_WATER = 4
const RB_REARTH = 19
const RB_RWINDR = 20
const RB_RFIRER = 21
const RB_RWATER = 22
const BIT_MRMAGI = 27

/** offensive_spell 시나리오 입력 — 자기완결(캐스터·주문·대상·방·굴림). */
export interface OffensiveInput {
  readonly gated: boolean
  readonly caster: { readonly class: number; readonly realm: readonly number[]; readonly intBonus: number }
  readonly osp: {
    readonly realm: number
    readonly ndice: number
    readonly sdice: number
    readonly pdice: number
    readonly bonusType: number
  }
  readonly target: {
    readonly kind: 'creature' | 'player'
    readonly hpcur: number
    readonly flags: string
    readonly piety: number
    readonly intelligence: number
  }
  readonly roomFlags: readonly number[]
  readonly rolls: readonly number[]
}

/** 관측 출력 — 적용 피해·최종 hp·사망·ledger 누적량·death 발화 횟수. */
export interface OffensiveOutput {
  readonly dmg: number
  readonly finalHp: number
  readonly died: boolean
  readonly ledgerAmount: number
  readonly deathFires: number
}

/** 독립 전사 F_ISSET(mtype.h:566) — hex string 바이트에서 지정 비트 판정. */
function oracleFIsset(hex: string, bit: number): boolean {
  const i = (bit >> 3) * 2
  const byte = parseInt(hex.substring(i, i + 2), 16)
  if (Number.isNaN(byte)) return false
  return ((byte >> (bit & 7)) & 1) === 1
}

/** bonusType → K(magic1.c:853-865). 1→10, 2→6, 3→4. */
function divisor(bonusType: number): number {
  if (bonusType === 1) return 10
  if (bonusType === 2) return 6
  if (bonusType === 3) return 4
  return 1
}

/** 방 상성 보정(magic1.c:867-895 독립 전사) — 동속성 ×2, 반대속성 min(-bns,-5). else-if 체인. */
function affinity(bns: number, realm: number, roomFlags: readonly number[]): number {
  const has = (bit: number) => oracleRoomFlag(roomFlags, bit)
  if (has(RB_RWATER)) {
    if (realm === R_WATER) return bns * 2
    if (realm === R_FIRE) return Math.min(-bns, -5)
  } else if (has(RB_RFIRER)) {
    if (realm === R_FIRE) return bns * 2
    if (realm === R_WATER) return Math.min(-bns, -5)
  } else if (has(RB_RWINDR)) {
    if (realm === R_WIND) return bns * 2
    if (realm === R_EARTH) return Math.min(-bns, -5)
  } else if (has(RB_REARTH)) {
    if (realm === R_EARTH) return bns * 2
    if (realm === R_WIND) return Math.min(-bns, -5)
  }
  return bns
}

/** 방 플래그(number[], F_ISSET bit) 독립 판정. */
function oracleRoomFlag(flags: readonly number[], bit: number): boolean {
  const idx = Math.floor(bit / 8)
  return ((flags[idx] ?? 0) & (1 << (bit % 8))) !== 0
}

/** 독립 전사 bns(magic1.c:853-895) — gated=false면 0. */
function oracleBns(input: OffensiveInput): number {
  if (!input.gated) return 0
  const { caster, osp } = input
  const bns = caster.intBonus + Math.trunc(oracleMprofic(caster.class, caster.realm, osp.realm) / divisor(osp.bonusType))
  return affinity(bns, osp.realm, input.roomFlags)
}

/**
 * 독립 전사 데미지 파이프(magic1.c:1096-1170). 데미지 순서: max(1) → 저항(creature+MRMAGI) →
 * m=min(hpBefore,dmg) → hp-=dmg → 사망. no-op(hpBefore<1)은 전부 0.
 */
function oracleOutput(input: OffensiveInput): OffensiveOutput {
  const bns = oracleBns(input)
  const rollSum = input.rolls.reduce((s, r) => s + r, 0)
  let dmg = Math.max(1, input.osp.pdice + bns + rollSum) // p + Σrolls, max(1) 저항 前

  const { target } = input
  if (target.kind === 'creature' && oracleFIsset(target.flags, BIT_MRMAGI)) {
    dmg -= Math.trunc((dmg * 2 * Math.min(50, target.piety + target.intelligence)) / 100)
  }

  const hpBefore = target.hpcur
  if (hpBefore < 1) return { dmg: 0, finalHp: hpBefore, died: false, ledgerAmount: 0, deathFires: 0 }

  const m = Math.min(hpBefore, dmg)
  const finalHp = hpBefore - dmg
  const died = finalHp < 1
  return {
    dmg,
    finalHp,
    died,
    ledgerAmount: target.kind === 'creature' ? m : 0,
    deathFires: died ? 1 : 0,
  }
}

function makeCase(input: OffensiveInput, note: string): GoldenFixture<OffensiveInput, OffensiveOutput>['cases'][number] {
  return { input, expected: oracleOutput(input), note }
}

const ZERO16 = '0000000000000000'
const MRMAGI_FLAGS = '0000000800000000' // 비트 27 세팅(바이트3 = 0x08). oracleFIsset로 검증.
const NO_ROOM = [0, 0, 0, 0, 0, 0, 0, 0]

/** 방 플래그 배열에 realm 비트 하나만 세팅한 배열을 만든다(F_ISSET 표현). */
function roomFlags(bit: number): number[] {
  const flags = [0, 0, 0, 0, 0, 0, 0, 0]
  const idx = Math.floor(bit / 8)
  flags[idx] = (flags[idx] ?? 0) | (1 << bit % 8)
  return flags
}

/**
 * 케이스를 조립한다:
 *   - tier별 데미지(tier1 1d8+0, tier2 2d5+7, tier5 4d5+30).
 *   - 방 상성 동속성 ×2·반대속성 약화(gated).
 *   - 마법저항 25%(50% 감산)·완전무효(piety+int>=50, min(50) cap).
 *   - auto-hit 사망(creature·player) + 오버킬 캡 m=min(hpBefore,dmg).
 *   - max(1) floor(gated 반대속성 음수 bns).
 */
export function buildCases(): GoldenFixture<OffensiveInput, OffensiveOutput>['cases'] {
  const baseCaster = { class: 5, realm: [0, 0, 0, 0], intBonus: 0 } // MAGE realm=0 → mprofic 0
  const creature = (over: Partial<OffensiveInput['target']> = {}): OffensiveInput['target'] => ({
    kind: 'creature',
    hpcur: 100,
    flags: ZERO16,
    piety: 0,
    intelligence: 0,
    ...over,
  })
  const player = (over: Partial<OffensiveInput['target']> = {}): OffensiveInput['target'] => ({
    kind: 'player',
    hpcur: 100,
    flags: '',
    piety: 0,
    intelligence: 0,
    ...over,
  })

  return [
    // tier1 1d8+0 (bonusType1). rolls=[6] → dmg=6.
    makeCase(
      { gated: false, caster: baseCaster, osp: { realm: R_WIND, ndice: 1, sdice: 8, pdice: 0, bonusType: 1 }, target: creature({ hpcur: 30 }), roomFlags: NO_ROOM, rolls: [6] },
      'tier1 1d8+0: dmg=6',
    ),
    // tier2 2d5+7 (bonusType2). rolls=[3,4] → dmg=14.
    makeCase(
      { gated: false, caster: baseCaster, osp: { realm: R_WIND, ndice: 2, sdice: 5, pdice: 7, bonusType: 2 }, target: creature({ hpcur: 30 }), roomFlags: NO_ROOM, rolls: [3, 4] },
      'tier2 2d5+7: dmg=14',
    ),
    // tier5 4d5+30 (bonusType3). rolls=[3,4,5,2] → dmg=44.
    makeCase(
      { gated: false, caster: baseCaster, osp: { realm: R_WIND, ndice: 4, sdice: 5, pdice: 30, bonusType: 3 }, target: creature({ hpcur: 100 }), roomFlags: NO_ROOM, rolls: [3, 4, 5, 2] },
      'tier5 4d5+30: dmg=44',
    ),
    // 방 상성 동속성 ×2 — gated, MAGE realm[WATER-1]=3072 → mprofic 25, bonusType2 K=6 → trunc(25/6)=4,
    // intBonus=2 → base bns=6, RWATER+WATER → ×2 → bns=12. dmg=7+12+7=26.
    makeCase(
      {
        gated: true,
        caster: { class: 5, realm: [0, 0, 0, 3072], intBonus: 2 },
        osp: { realm: R_WATER, ndice: 2, sdice: 5, pdice: 7, bonusType: 2 },
        target: creature({ hpcur: 100 }),
        roomFlags: roomFlags(RB_RWATER),
        rolls: [3, 4],
      },
      '방 상성 동속성 ×2: bns=12, dmg=26',
    ),
    // 방 상성 반대속성 약화 — gated, base bns=6, RFIRER+WATER → min(-6,-5)=-6. dmg=max(1,7-6+7)=8.
    makeCase(
      {
        gated: true,
        caster: { class: 5, realm: [0, 0, 0, 3072], intBonus: 2 },
        osp: { realm: R_WATER, ndice: 2, sdice: 5, pdice: 7, bonusType: 2 },
        target: creature({ hpcur: 100 }),
        roomFlags: roomFlags(RB_RFIRER),
        rolls: [3, 4],
      },
      '방 상성 반대속성 약화: bns=-6, dmg=8',
    ),
    // max(1) floor — gated, realm=0 caster(mprofic 0, intBonus 0) → base 0, RFIRER+WATER → min(-0,-5)=-5.
    // dmg=max(1, 0-5+1)=1.
    makeCase(
      {
        gated: true,
        caster: baseCaster,
        osp: { realm: R_WATER, ndice: 1, sdice: 8, pdice: 0, bonusType: 1 },
        target: creature({ hpcur: 30 }),
        roomFlags: roomFlags(RB_RFIRER),
        rolls: [1],
      },
      'max(1) floor: bns=-5, dmg=1',
    ),
    // 마법저항 50% 감산 — creature MRMAGI, piety+int=25. dmg=14 → 14-trunc(14*2*25/100)=7.
    makeCase(
      {
        gated: false,
        caster: baseCaster,
        osp: { realm: R_WIND, ndice: 2, sdice: 5, pdice: 7, bonusType: 2 },
        target: creature({ hpcur: 30, flags: MRMAGI_FLAGS, piety: 15, intelligence: 10 }),
        roomFlags: NO_ROOM,
        rolls: [3, 4],
      },
      '마법저항 50% 감산: dmg 14→7',
    ),
    // 마법저항 완전무효 — piety+int=60 → min(50) → dmg -= 14 → 0. hp 불변.
    makeCase(
      {
        gated: false,
        caster: baseCaster,
        osp: { realm: R_WIND, ndice: 2, sdice: 5, pdice: 7, bonusType: 2 },
        target: creature({ hpcur: 30, flags: MRMAGI_FLAGS, piety: 40, intelligence: 20 }),
        roomFlags: NO_ROOM,
        rolls: [3, 4],
      },
      '마법저항 완전무효: dmg 14→0, hp 불변',
    ),
    // auto-hit 사망(creature) + 오버킬 캡 — hp=5, dmg=14 → m=min(5,14)=5, finalHp=-9, deathFires=1.
    makeCase(
      {
        gated: false,
        caster: baseCaster,
        osp: { realm: R_WIND, ndice: 2, sdice: 5, pdice: 7, bonusType: 2 },
        target: creature({ hpcur: 5 }),
        roomFlags: NO_ROOM,
        rolls: [3, 4],
      },
      'creature 사망 + 오버킬 캡: m=5, finalHp=-9, deathFires=1',
    ),
    // player 대상 사망 — ledger 미누적(creature만), firePlayerDeath 1회.
    makeCase(
      {
        gated: false,
        caster: baseCaster,
        osp: { realm: R_WIND, ndice: 2, sdice: 5, pdice: 7, bonusType: 2 },
        target: player({ hpcur: 3 }),
        roomFlags: NO_ROOM,
        rolls: [3, 4],
      },
      'player 사망: ledger 0, deathFires=1',
    ),
    // player 대상 생존 — 저항 미발동·ledger 미누적.
    makeCase(
      {
        gated: false,
        caster: baseCaster,
        osp: { realm: R_WIND, ndice: 2, sdice: 5, pdice: 7, bonusType: 2 },
        target: player({ hpcur: 30 }),
        roomFlags: NO_ROOM,
        rolls: [3, 4],
      },
      'player 생존: dmg=14, ledger 0',
    ),
  ]
}

/** 케이스를 골든 fixture로 감싼다. `generatedAt`은 주입 clock으로 결정적 스탬프. */
export function buildFixture(clock: () => Date): GoldenFixture<OffensiveInput, OffensiveOutput> {
  return makeManualFixture('offensive_spell', 'magic1.c:820-1170 (A6 §2)', buildCases(), clock)
}
