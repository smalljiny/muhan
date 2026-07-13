# 골든 fixture 하네스

> C oracle 대조 frozen 골든 fixture로 게임 규칙 공식을 검증하는 approval-test 인프라. `packages/shared/src/oracle/`에 위치한다.

## 개요

`legacy/muhan/src`의 원본 C 함수를 behavioral oracle로 삼아, 그 동작을 JS 재구현이 재현하는지 검증하는 approval-test 하네스다(characterization = golden master = approval 동일 기법, ADR D7 §3.9). oracle은 fixture *생성기*로만 쓰고 산출물(기대 출력)을 JSON으로 체크인하며, CI는 순수 TypeScript로 체크인 fixture와 SUT(system under test) 출력을 대조한다 — 32비트 i386 툴체인은 CI에 불필요하고 생성 시점(개발자 로컬)에만 쓰인다.

이 하네스는 E6(게임 규칙 엔진: 전투·마법·진행·경제)의 선행 조건이다. E6가 각 공식을 골든 fixture로 TDD하려면 포맷·러너·생성기 규약이 먼저 존재해야 한다. 대표 공식 `compute_ac`(방어도) 하나로 생성기→fixture→러너 루프를 end-to-end 증명한다.

공개 API는 `packages/shared`의 배럴(`src/index.ts`)에서 `goldenFixtureSchema`·`GoldenFixture`·`approve` 셋만 노출한다. SUT(`computeAc`)와 생성기(`computeAcFixture`)는 비공개로 두어 blast radius를 oracle 서브트리로 한정한다.

## 구조

```
packages/shared/src/oracle/
├── types.ts                      # fixture JSON 포맷·zod 스키마·GoldenFixture 제네릭 타입
├── runner.ts                     # approve() — 체크인 fixture 대조 러너
├── computeAc.ts                  # 대표 SUT (self-test용 방어도 계산)
├── fixtures/
│   └── compute_ac.json           # 체크인 frozen fixture
└── generators/
    └── computeAcFixture.ts       # manual 생성기 (참조 구현 + 기대값 산출·기록)
```

### fixture JSON 포맷

함수 하나당 JSON fixture 파일 하나. 좁게 유지하고 여러 함수를 한 파일에 섞지 않는다.

```jsonc
{
  "fn": "compute_ac",                       // 대상 함수명 (min 1)
  "oracle": {
    "method": "manual",                     // "manual" | "c-compile"
    "source": "player.c:971 (A5 §6 a5-combat.md:184)",  // oracle 출처 라인
    "generatedAt": "2026-07-13T00:00:00.000Z",          // ISO datetime, 체크인 후 frozen
    "seed": null                            // RNG 공식이면 고정 시드, 순수면 null
  },
  "cases": [                                // min 1 — 빈 배열 거부
    { "input": { "dexterity": 10, "equipArmor": 0, "protection": false }, "expected": 100 }
  ]
}
```

### zod 스키마 (`types.ts`)

`goldenFixtureSchema`는 fixture *봉투*를 엄격 검증한다:

- 최상위·case 모두 `z.strictObject` — 오타 키(예: `notee`)를 조용히 수용하지 않고 거부한다.
- `fn`·`oracle.source`는 `.min(1)`, `oracle.method`는 `enum(['manual','c-compile'])`, `oracle.generatedAt`는 `z.iso.datetime()`, `oracle.seed`는 `number().nullable()`(키 필수·값 nullable).
- `cases`는 `.min(1)` — 빈 cases는 러너가 무조건 통과하는 vacuous-pass 구멍이므로 스키마 층에서 거부한다.
- case의 `input`·`expected`는 `z.unknown()`(키는 필수, 값은 임의). payload 타입은 per-fixture 제네릭 캐스트(`GoldenFixture<I, O>`)로 지연한다. `note`는 선택(`string().min(1).optional()`) — 케이스 의도·검증 주의를 데이터로 표기.

`GoldenFixture<I = unknown, O = unknown>`는 손수 제네릭 wrapper다. base(`fn`·`oracle`)는 `z.infer`로 파생하고 `cases`만 `{ input: I; expected: O; note?: string }[]`로 오버라이드한다 — z.infer는 제네릭 파라미터화가 불가능하므로, 하네스 인프라 타입에 한해 정당한 예외다(도메인 타입은 z.infer-only 규칙 유지).

### frozen 규약

- `generatedAt`·case별 `expected`는 체크인 후 **고정**이다. 회귀 테스트는 디스크의 값을 진실로 삼고 재계산하지 않는다.
- 재생성은 **수동 트리거**로만 이뤄진다 — 사람이 생성기 스크립트를 직접 실행할 때만 `expected`·`generatedAt`이 갱신된다. 테스트 도중 자동 재생성은 없다.

## 동작

### approval 러너 — `approve(fixture, sut)`

```ts
export function approve<I, O>(fixture: GoldenFixture<I, O>, sut: (input: I) => O): void
```

`fixture.cases`를 순회하며 각 case의 `input`으로 `sut`를 실행하고 `expected`와 대조한다. 불일치가 하나도 없으면 void 반환, 하나 이상이면 수집된 전 불일치를 집계한 메시지로 `Error`를 throw한다.

- **fail-fast 금지**: 첫 불일치에서 멈추지 않고 전 케이스를 끝까지 순회해 모든 불일치를 수집한다. 회귀 한 번에 얼마나 광범위하게 깨졌는지 케이스 단위 diff로 본다.
- **structural 동등 비교**: `node:util.isDeepStrictEqual`을 쓴다. SUT가 number를 반환하면 `===`로 충분하지만 러너는 제네릭이라 객체·배열 출력도 받는다. `JSON.stringify` 비교는 키 순서 의존·`undefined` 손실·`NaN` 왜곡 문제가 있어 채택하지 않는다.
- **에러 렌더링**: `node:util.inspect(v, { depth: null, breakLength: Infinity })`로 case index·input·expected·actual을 렌더한다(비교와 동일 계열의 견고한 렌더러).
- **boundary 가드**: 빈 `cases`는 불일치 0건으로 무조건 통과하는 vacuous-pass다. `goldenFixtureSchema`가 `.min(1)`로 이를 막지만, `approve`는 파싱을 거치지 않은 캐스팅 fixture도 받는 공개 재사용 러너이므로 진입점에서 `cases.length === 0`을 다시 throw로 거부한다(defense-in-depth).

### manual 생성기 (`generators/computeAcFixture.ts`)

순수 TS 스크립트가 공식을 참조 구현(`referenceComputeAc`)하고, 선택 입력에 대해 기대값을 산출해 fixture로 기록한다. `method: "manual"`, `source`에 C 라인을 명시한다. 참조 구현은 fixture 생성 전용이며 러너의 SUT(`computeAc`)와 **독립 표현**이다 — 같은 공식의 두 독립 구현이 교차 검증 역할을 해 transcription 리스크를 방어한다.

주요 export: `bonus`(원본 상수 테이블), `ComputeAcInput` 타입, `referenceComputeAc`(참조 구현), `buildCases`·`buildFixture(clock)`(fixture 조립), `writeFixtureFile(path, fixture)`(디스크 기록). 재생성은 문서화된 수동 명령으로 `buildFixture`에 고정 시각 clock을 주입해 실행한다.

### 대표 공식 self-test — `compute_ac`

`compute_ac`는 하네스가 실제로 도는지 시연하는 SUT다(E6 전투 엔진 편입 여부는 E6 결정, self-test 참조일 뿐).

공식: `ac = 100 - 5·bonus[MIN(dexterity, 63)] - equipArmor - (protection ? 10 : 0)`, 최종 `[-127, 127]`로 clamp. 원본 `player.c:971` 정공식이다. SUT `computeAc`는 참조 구현과 **의도적으로 다른 표현**(명시적 clamp 헬퍼 + 직접 산술 체이닝)으로 작성해 우연한 문장 일치(tautology)를 피한다. `bonus` 테이블은 원본 상수라 재정의하지 않고 생성기의 것을 재사용한다.

end-to-end 데모는 (a) 체크인 fixture 전 케이스가 `computeAc`를 throw 없이 통과, (b) post-clamp `+1` 버그를 주입한 변형에는 `approve`가 throw(negative control — 러너가 실제 차이를 잡아냄 = 데모가 tautology 아님), (c) clamp 하한(-127)·상한(127) 경계 케이스가 통과 집합에 포함됨을 검증한다.

## 제약사항

- **E8-1은 manual 경로만 실체화한다**. fixture 포맷의 `method` enum은 `'manual'|'c-compile'`을 후확장 여지로 보존하되, E8-1의 값은 항상 `'manual'`이다. c-compile 생성기(격리 i386 드라이버·Dockerfile·예시)는 첫 소비자 E6 서브 토픽으로 전면 이연한다.
- **CI 불변식**: 생성 방법과 무관하게 CI는 체크인 JSON을 순수 TS로 로드·대조만 한다. i386 툴체인은 생성 시점(개발자 로컬)에만 필요하다.
- **범위**: 하네스 + 대표 공식 1개(`compute_ac`) 데모만. 실 게임 규칙 공식 구현(전투·마법·진행·경제 엔진)은 E6, property 테스트(RNG 시드 고정·불변식)는 E8-2다. 각 공식의 fixture는 해당 E6 서브 토픽이 그 공식을 구현할 때 생성한다.
- **as-shipped 정책(P1)**: as-shipped 버그는 fixture에 '선택된 동작'으로 assert한다. 버그별 재현/수정 개별 태깅은 각 E6 서브 토픽이 담당한다.
- **payload 검증**: fixture 봉투는 엄격 검증하나 case의 `input`/`expected` payload는 `z.unknown()`으로 지연한다. fixture는 체크인·리뷰된 정적 산출물이므로 수용 가능하다. 향후 fixture가 runtime·untrusted 소스에서 로드되면 function-specific Zod 스키마로 강화한다.

## 관련 문서

- ADR: `docs/specs/architecture.md` §3.9(D7 테스트 전략)
- 분석 노트: `docs/notes/game-analysis-20260625/a5-combat.md`(공식 정본, `compute_ac`는 §184)
- oracle 코드: `legacy/muhan/src/player.c:971`(방어도 공식)
- 부모 에픽·이슈: #33(E8), #70(본 토픽), #71(E8-2 property), #36(E6 소비자)
