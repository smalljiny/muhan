import type { GoldenFixture } from '../types.js'
import { makeManualFixture, writeFixtureFile } from './fixtureIo.js'

// 재생성 명령이 `import { buildFixture, writeFixtureFile }`로 소비하므로 writer를 re-export한다.
export { writeFixtureFile }

/**
 * spell store 직렬화 골든 fixture 생성기 — manual oracle.
 *
 * 원본 `mtype.h:570-571`의 S_ISSET/S_SET 비트 레이아웃을 **독립 리터럴로 전사**(전사 pass 2)해
 * {setBits[], queryBit} → boolean 왕복 케이스로 감싼다. SUT `isKnown`/`setKnown`(shared/magic)은
 * spellStore.ts의 구현(전사 pass 1)을 소비하므로, approve가 두 전사의 불일치를 잡아낸다.
 *
 * expected는 이 파일의 `oracleKnownAfterSet`(mtype.h 독립 전사)에서 계산한다 — spellStore.ts를
 * import하지 않는다. import하면 SUT와 fixture가 같은 코드가 되어 anti-tautology가 무너진다.
 *
 * SUT 소비 approve는 server가 소유한다(`packages/server/src/magic/spellStore.test.ts`) — 완료 기준
 * "server 테스트에서 approve"에 맞춰 server가 디스크 json을 읽어 shared SUT로 approve를 실행한다
 * (mprofic 선례).
 *
 * ## 재생성 (수동 트리거)
 * `.js` 확장자 ESM re-export를 소비하므로 plain `node -e`는 `.js`→`.ts` 해석에 실패한다. TS 로더(tsx)로 실행한다:
 * ```
 * cd packages/shared
 * node ../server/node_modules/tsx/dist/cli.mjs --eval "import { buildFixture, writeFixtureFile } from './src/oracle/generators/spellStoreFixture.ts'; writeFixtureFile('./src/oracle/fixtures/spellStore.json', buildFixture(() => new Date('2026-07-16T00:00:00.000Z')))"
 * ```
 */

/** spell store 왕복 입력 — 순서대로 S_SET할 비트 목록·S_ISSET로 조회할 비트. */
export interface SpellStoreInput {
  readonly setBits: readonly number[]
  readonly queryBit: number
}

/** spell store 폭 — mtype.h spells[16] 리터럴(server 상수 미참조). */
const ORACLE_STORE_BYTES = 16

/**
 * 독립 전사(pass 2) — mtype.h:570-571. setBits를 순서대로 S_SET한 뒤 queryBit를 S_ISSET한다.
 * store[f/8] |= 1<<(f%8); return (store[q/8] & 1<<(q/8&7)) != 0. f/8=f>>3, f%8=f&7.
 */
export function oracleKnownAfterSet(setBits: readonly number[], queryBit: number): boolean {
  const store = new Array<number>(ORACLE_STORE_BYTES).fill(0)
  for (const f of setBits) {
    const idx = Math.floor(f / 8)
    store[idx] = (store[idx] ?? 0) | (1 << (f % 8))
  }
  const byte = store[Math.floor(queryBit / 8)] ?? 0
  return (byte & (1 << (queryBit % 8))) !== 0
}

/** input을 oracleKnownAfterSet로 감싼 케이스로 만든다(expected는 독립 전사 계산값). */
function makeCase(
  input: SpellStoreInput,
  note?: string,
): GoldenFixture<SpellStoreInput, boolean>['cases'][number] {
  const base = { input, expected: oracleKnownAfterSet(input.setBits, input.queryBit) }
  return note ? { ...base, note } : base
}

/**
 * 케이스를 조립한다:
 *   - 빈 store → 어느 비트든 false.
 *   - 세팅 비트 자신 → true, 인접·다른 바이트 비트 → false.
 *   - 바이트 경계(비트 7 vs 8) 정확성.
 *   - 카탈로그 최대 주문번호(SCHARM=55)·128비트 최대(127) 세팅.
 *   - 다중 세팅 후 각 비트 조회.
 */
export function buildCases(): GoldenFixture<SpellStoreInput, boolean>['cases'] {
  return [
    makeCase({ setBits: [], queryBit: 0 }, '빈 store → false'),
    makeCase({ setBits: [], queryBit: 127 }, '빈 store 최고비트 → false'),
    makeCase({ setBits: [6], queryBit: 6 }, '세팅 비트 자신 → true'),
    makeCase({ setBits: [6], queryBit: 5 }, '인접 하위 비트 → false'),
    makeCase({ setBits: [6], queryBit: 7 }, '인접 상위 비트 → false'),
    makeCase({ setBits: [7], queryBit: 7 }, '바이트0 최상위 비트 → true'),
    makeCase({ setBits: [8], queryBit: 8 }, '바이트1 최하위 비트 → true'),
    makeCase({ setBits: [8], queryBit: 0 }, '바이트 경계: 비트8 세팅 시 비트0 → false'),
    makeCase({ setBits: [55], queryBit: 55 }, '카탈로그 최대 SCHARM=55 → true'),
    makeCase({ setBits: [55], queryBit: 47 }, '동일 바이트 다른 비트 → false'),
    makeCase({ setBits: [127], queryBit: 127 }, '128비트 최대 → true'),
    makeCase({ setBits: [0, 6, 13, 55, 127], queryBit: 13 }, '다중 세팅 후 중간 조회 → true'),
    makeCase({ setBits: [0, 6, 13, 55, 127], queryBit: 54 }, '다중 세팅 후 미세팅 조회 → false'),
    makeCase({ setBits: [6, 6], queryBit: 6 }, 'idempotent 재세팅 → true'),
  ]
}

/** 케이스를 골든 fixture로 감싼다. `generatedAt`은 주입 clock으로 결정적 스탬프. */
export function buildFixture(clock: () => Date): GoldenFixture<SpellStoreInput, boolean> {
  return makeManualFixture('spellStore', 'mtype.h:570-571 (S_ISSET/S_SET, A6 §8)', buildCases(), clock)
}
