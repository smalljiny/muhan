# property 테스트 프레임워크

> RNG 시드를 고정한 전제로 게임 규칙의 입력 범위 불변식을 검증하는 fast-check 기반 property 테스트 인프라. 순수 심볼은 `packages/shared`의 public API로, fast-check arbitrary는 test-only로 분리한다.

## 개요

골든 fixture 하네스(`docs/specs/golden-fixture-harness.md`)가 **특정 입력의 정확값**을 C oracle과 대조하는 반면, property 테스트는 다른 축이다 — **입력 범위 전체의 불변식**(값 범위·단조성·전이 totality 등)을 검증한다. 이를 결정적으로 재현하려면 RNG 시드 고정이 전제다.

이 프레임워크는 세 조각으로 이뤄진다:
1. **시드 결정적 PRNG** — 같은 시드가 항상 같은 굴림 시퀀스를 내는 의존 0 순수 PRNG.
2. **불변식 헬퍼 + 범위 생성기** — property 공통 assert(순수, fast-check 무의존)와 fast-check arbitrary 범위 생성기(test-only).
3. **시연 property 테스트** — 지금 존재하는 결정적 규칙(E4 스폰 seam·문 FSM·`checkExits` + oracle `compute_ac`)에 프레임워크를 적용해 실제 회귀를 잡음을 증명한다(vacuous 아님).

실 전투·마법·exp 공식의 불변식(E6)은 본 프레임워크 범위 밖이며, 그 규칙이 구현되는 E6에서 이 위에 얹는다.

## 구조

패키지 경계를 지킨다 — `packages/server`가 `packages/shared`를 import하는 **단방향** 의존만 존재한다(shared는 server를 절대 import하지 않는다). 순수 심볼은 dist public API로, fast-check를 import하는 arbitrary는 test-only 파일로 분리한다.

```
packages/shared/src/property/
├── seededRng.ts              순수 seedable PRNG (mulberry32). 의존 0. dist public API.
├── seededRng.test.ts         결정성·범위·골든 벡터 단위 테스트.
├── invariants.ts             불변식 assert (assertInRange·assertMonotonic). 순수, fast-check 무의존. dist public API.
├── invariants.test.ts        위반·충족 양 경로 단위 테스트.
└── arbitraries.testutil.ts   fast-check arbitrary 범위 생성기. test-only(build·coverage 제외).

packages/shared/src/oracle/
└── computeAc.property.test.ts   compute_ac 범위·단조성 시연.

packages/server/src/world/
├── seededRngSeams.testutil.ts   server 소유 SpawnRng·CreatureRng를 shared seededRng로 구현하는 어댑터. test-only.
├── seededRngSeams.test.ts       어댑터 계약 테스트.
├── randomSpawn.property.test.ts 스폰 seam 범위 시연.
├── door.property.test.ts        문 FSM totality + 사후 불변식 시연.
└── checkExits.property.test.ts  checkExits 불변식 시연.
```

### 공개 API 경계

`packages/shared/src/index.ts`가 순수 심볼 넷을 배럴에서 노출한다:

| 심볼 | 시그니처 | 책임 |
|------|---------|------|
| `makeSeededRng` | `(seed: number) => () => number` | mulberry32 생성기. 호출마다 `[0, 1)`. |
| `nextIntInRange` | `(rng: () => number, lo: number, hi: number) => number` | `[lo, hi]` 정수(양끝 포함). `hi < lo`면 `RangeError`. |
| `assertInRange` | `(x, lo, hi, label) => void` | 닫힌 구간 `[lo, hi]` 위반 시 반례 값 포함 `RangeError`. |
| `assertMonotonic` | `(values, 'non-increasing' \| 'non-decreasing', label) => void` | 방향 위반 시 위반 인덱스·인접쌍 포함 `Error`. 빈 배열·단일 원소는 무동작. |

fast-check arbitrary(`intInRangeArb`·`seedArb`·`computeAcInputArb`)는 `arbitraries.testutil.ts`에만 있고 배럴에 노출하지 않는다.

## 동작

### seededRng — mulberry32

단일 uint32 상태로 32비트 결정성을 갖는다. 곱셈은 `Math.imul`로 32비트 정수 곱을 강제하고 최종 변환은 `>>> 0`로 부호 없는 32비트로 맞춰, 플랫폼 무관 결정성을 보장한다(plain `*`는 저비트를 잃어 결정성이 깨진다). 같은 시드는 항상 같은 시퀀스를 재현하며, 음수 시드도 `seed >>> 0`으로 uint32 강제돼 결정적이다.

> ⚠️ **암호학적으로 안전하지 않다.** mulberry32는 상태 전이가 예측 가능해 시드나 이전 출력으로 향후 출력을 복원할 수 있다. 토큰·세션 ID·비밀번호·인증 코드 등 보안 컨텍스트에는 사용하지 않는다 — 그 용도는 `crypto`를 쓴다. 유일한 목적은 테스트·게임 굴림의 재현이다.

### 불변식 assert

`assertInRange`·`assertMonotonic`은 순수 함수이며 fast-check를 import하지 않는다. `fc.property` 콜백 안에서 호출되면 위반 시 반례 메시지가 fast-check의 shrink된 최소 반례와 함께 리포트에 노출된다.

### fast-check arbitrary (test-only)

`arbitraries.testutil.ts`가 세 생성기를 export한다: `intInRangeArb(lo, hi)`(정수 범위), `seedArb`(uint32 시드), `computeAcInputArb`(`ComputeAcInput` 구조체). `*.testutil.ts` glob으로 build·coverage 양쪽에서 제외돼 fast-check가 dist 산출물·커버리지 리포트에 노출되지 않는다.

### 크로스패키지 재사용 (shared·server 단일 위치)

shared·server 양쪽 테스트가 arbitrary를 **단일 shared 위치**에서 소비한다:
- **순수 심볼**(PRNG·invariants)은 server가 bare `'shared'`(dist 경유)로 import한다.
- **arbitrary**는 fast-check를 import해 dist에 미포함이므로, server 테스트가 **소스**에서 subpath로 해석해 import한다(`shared/property/arbitraries.testutil`). 이를 위해 `packages/server/vitest.config.ts`에 `resolve.alias`(`/^shared\/(.*)$/` → `../shared/src/$1`)를, `tsconfig.json` `paths`에 `"shared/*": ["../shared/src/*"]`를 둔다. bare `shared`(슬래시 없음)는 정규식에 안 걸려 dist 경로를 유지한다.

### RNG seam 어댑터

`seededRngSeams.testutil.ts`가 shared `makeSeededRng`를 import해 **server 소유** seam(`randomSpawn.ts`의 `SpawnRng`, `creatureFactory.ts`의 `CreatureRng`)을 구현한다(server→shared 정방향, seam 신설 없음). `seededSpawnRng(seed)`는 `roll100`∈[1,100]·`pickIndex(len)`∈[0,len-1]·`groupSize(max)`∈[1,max]를, `seededCreatureRng(seed)`는 `(baseGold)`∈[0,baseGold]를 낸다. 세 메서드가 단일 rng 클로저를 공유해 호출마다 상태가 전진하는 결정적 시퀀스를 이룬다. 미주입 시 기본 stub은 seam 정의부의 `defaultSpawnRng`·`defaultCreatureRng`다(어댑터가 기본이 아니다).

### 시연 범위와 비-vacuity 증명

시연 대상은 스폰(그룹 크기·`pickIndex`) + 문 FSM totality + `checkExits` 불변식 + `compute_ac` 범위·단조성이다. `tryMove`는 방 그래프·게이트·flee seam 등 무거운 DI 조립이 필요해 제외한다.

각 시연은 tautology가 아닌 실제 SUT를 구동한다. 성공 경로 사후조건은 성공-적격 fixture에서 `result === true`를 무조건 단정해 성공 분기를 구조적으로 관측한다(vacuous 방지). 비-vacuity는 각 시연에서 불변식 경계를 일부러 뒤집어 fast-check가 shrink된 반례 + `seed`/`path`를 보고함을 확인하는 개발 시점 수동 단계로 증명한다(CI 재실행 게이트 아님). 재현은 `fc.assert(prop, { seed, path })`로 고정한다.

## 제약사항

- **fast-check는 테스트 표면에만.** devDependency(pnpm catalog `^3.23.0`)로 도입하며 `*.test.ts`·`*.testutil.ts`에서만 import한다. shared 런타임 public API·dist 산출물에 노출하지 않는다.
- **seededRng는 비암호 PRNG.** dist public API로 노출되나 보안 컨텍스트 사용은 JSDoc 경고로 금지한다. 하드 런타임/API 경계 강제는 후속 과제로 남는다.
- **RNG seam 신설·이동 없음.** e4-2 server 소유 `SpawnRng`·`CreatureRng`를 재사용한다. 프로덕션 randomSpawn에 실 rng를 배선하지 않는다(테스트 어댑터만). 실 배선은 E6/해당 규칙 토픽에서, 그 시점에 RPLWAN 그룹 굴림 전 `occupants.size === 0` 가드가 필요하다.
- **커스텀 shrinking 엔진 없음.** fast-check 내장 shrinking을 사용한다.
- **실 게임 공식 불변식은 범위 밖.** 전투 데미지·명중률·exp 곡선 등은 E6에서 이 프레임워크 위에 얹는다.
