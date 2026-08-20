import { characterSchema, type Character } from 'shared'

/**
 * 캐릭터 시드 픽스처 — 서버 테스트가 공유하는 최소 유효 `Character` 문서.
 *
 * `items/objectFixtures.testutil.ts`가 세운 선례를 따른다. 그 헤더가 적은 복제 비용이 캐릭터
 * 문서에서도 실제로 발생했다 — 같은 18필드 리터럴이 여러 테스트 파일에 흩어졌고, 그러는 사이
 * `schemaVersion`이 파일마다 갈렸다(5와 6이 공존). `characterSchema`가 다시 바뀌면 각 사본을 따로
 * 고쳐야 하고, 한 곳을 빠뜨려도 테스트는 계속 통과한다.
 *
 * `characterSchema.parse`를 통과시켜 만드는 것이 load-bearing이다. 리터럴을 그대로 반환하면 스키마가
 * 거부할 시드로도 테스트가 통과해, 배선이 실제로 유효한 문서를 다루는지 검증하지 못한다.
 *
 * 파일명이 `.testutil.ts`라 server build(tsconfig.build.json)·coverage(vitest.config.ts) 양쪽 glob에서
 * 자동 제외된다(테스트 인프라, 프로덕션 코드 아님).
 */

/** 능력치 튜플 순서: strength0·dexterity1·constitution2·intelligence3·piety4. */
export const SEED_STRENGTH = 16
export const SEED_DEXTERITY = 18

/**
 * 최소 유효 `Character` — 어느 게이트에도 걸리지 않는 중립 시드다.
 *
 * 값에 의미를 두지 않는다. 특정 값이 테스트의 근거가 되면(예: 훈련방 클래스 일치, exp 임계) 그
 * 테스트가 `overrides`로 **명시**해 근거를 자기 파일 안에 남긴다 — 여기 기본값을 읽어야 이해되는
 * 테스트는 시드가 바뀌는 순간 이유 없이 깨진다.
 */
export function makeCharacter(overrides: Partial<Character> = {}): Character {
  return characterSchema.parse({
    _id: 'char-1',
    name: '테스토스',
    class: 4,
    race: 1,
    stats: [SEED_STRENGTH, SEED_DEXTERITY, 12, 10, 14],
    gold: 100,
    currentRoom: 1,
    hpCurrent: 42,
    mpCurrent: 15,
    level: 7,
    experience: 0,
    spells: new Array<number>(16).fill(0),
    realm: [0, 0, 0, 0],
    schemaVersion: 6,
    accountId: 'acct-1',
    status: 'active',
    alignment: 1,
    ...overrides,
  })
}
