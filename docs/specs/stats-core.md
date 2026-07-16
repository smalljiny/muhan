# stats-core

> base 능력치 + 모디파이어 레이어 분리와 파생 스탯(AC·THAC0·소지량·HP/MP 최대치)의 순수 계산 라이브러리. `packages/shared/src/stats/`에 위치한다.

## 개요

무한의 전투·경제·레벨링이 공유하는 스탯 계산을 순수 함수 라이브러리로 제공한다. E6 게임 규칙 엔진(전투·마법·진행·경제)이 소비하는 계산 기반이며, 상태·영속·스케줄러를 갖지 않는다.

원본 무한은 dex/str 변형마다 `compute_ac`/`compute_thaco`를 수동 호출하고 누락 시 필드가 stale해지는 "필드 직접 변형" 모델이다(A7 §12). 버프·장비 보정이 base 능력치에 직접 가산돼 base와 유효값이 미분리 상태다. stats-core는 이를 두 계층으로 분리한다:

- **effectiveStat 계층** — base 영속 능력치 + 모디파이어(버프·장비·종족)를 유효 능력치로 합성.
- **파생 resolver 계층** — 유효 능력치 스냅샷(`EffectiveStatContext`)을 받아 파생 스탯을 계산.

소비자는 "필드 가감" 대신 "context 조립 → 재계산"으로 상태 일관성을 확보한다. base(`characterSchema.stats`·level 등)와 자신의 modifier로 context를 조립해 resolver를 호출하며, stats-core는 modifier를 **소비**만 한다(생성은 전투·마법·아이템 소유 토픽).

## 구조 / 스키마

```
packages/shared/src/stats/
├── tables.ts        # bonus[64]·class_stats·thaco_list[13][20]·mod_profic 정적 const + clamp 내장 접근자
├── effectiveStat.ts # effectiveStat(base, modifiers[]) + StatModifier 타입
├── context.ts       # EffectiveStatContext 입력 타입 (resolver 5종 필드 합집합)
├── derived.ts       # computeAc·computeThaco·maxWeight·computeHpMax·computeMpMax
└── index.ts         # 공개 배럴
```

공개 배럴(`packages/shared/src/index.ts` → `stats/index.js`)이 노출하는 값·타입:

- 값: `bonus`·`bonusOf`·`StatIndex`·`class_stats`·`classStatOf`·`thaco_list`·`thacoOf`·`mod_profic`·`proficDivisorOf`·`effectiveStat`·`computeAc`·`computeThaco`·`maxWeight`·`computeHpMax`·`computeMpMax`
- 타입: `StatKey`·`ClassStats`·`StatModifier`·`EffectiveStatContext`

`tables.ts`는 런타임 I/O(`node:fs` 등)를 절대 포함하지 않아 서버·클라이언트 양쪽에서 안전하게 import된다.

### 정적 테이블 (tables.ts)

원본 C 전역 상수를 32비트 oracle에서 전사한 4종:

| 테이블 | 형태 | 원본 | 용도 |
|--------|------|------|------|
| `bonus[64]` | `number[]` (정확히 64) | `player.c` 전역 | 능력치→보너스, compute_ac 등 재사용 |
| `class_stats[13]` | `ClassStats[]` | `global.c:37` | 클래스별 HP/MP 성장·타격 주사위 |
| `thaco_list[13][20]` | `number[][]` | `global.c:105` | 클래스×레벨 THAC0 (0행·0열 placeholder) |
| `mod_profic[13]` | `number[]` | `player.c:1032` | 클래스→숙련도 나눗수 |

`StatIndex`는 creature 구조체 stat 배열의 고정 순서 상수 `{strength:0, dexterity:1, constitution:2, intelligence:3, piety:4}`(mstruct.h:177-181, A7 §1)다.

### EffectiveStatContext

resolver 5종이 판독하는 필드의 합집합. 각 필드는 이미 합성된 유효값(`effective*`) 또는 순수 입력이며, resolver는 자신이 필요한 필드만 읽는다.

| 필드 | 판독 resolver |
|------|---------------|
| `effectiveDexterity` | computeAc |
| `effectiveStrength` | computeThaco, maxWeight |
| `equipArmor` (부호 있음) | computeAc |
| `protection` (PPROTE) | computeAc |
| `characterClass` (1-12) | computeThaco, maxWeight, computeHpMax, computeMpMax |
| `level` | computeThaco, maxWeight, computeHpMax, computeMpMax |
| `weaponAdjustment` | computeThaco |
| `weaponProficiency` (0-100) | computeThaco |

## 동작

### effectiveStat 합성

`effectiveStat(base, modifiers[])`는 `base + Σ modifiers.delta`의 순수 가산이며 clamp를 넣지 않는다 — `[3, 18]` 같은 상한은 상위 계층 책임이고, 이 계층은 버프가 유효값을 18 초과로 밀 수 있어야 한다. `StatModifier`는 `{ source, stat, delta }`이며, `stat`은 소비자가 stat별 modifier를 선별할 때 쓰는 메타데이터다 — `effectiveStat` 자체는 stat-agnostic이라 이 필드를 읽지 않는다(소비자가 prefilter하는 계약).

### 파생 resolver 5종

산술 정본의 위치가 두 모델로 나뉜다:

- **computeAc** — `oracle/computeAc.ts`가 산술 정본이고, resolver는 `EffectiveStatContext`를 `ComputeAcInput`으로 어댑트해 호출하는 얇은 wrapper다(드리프트 0). 공식: `ac = 100 - 5·bonus[MIN(dex,63)] - equipArmor - (protection?10:0)`, 최종 `[-127,127]` clamp (`player.c:971`).
- **computeThaco·maxWeight·computeHpMax·computeMpMax** — 산술 정본이 resolver 함수 자체다. 독립 참조 구현(`oracle/generators/*Fixture.ts`)이 골든 fixture를 생성해 교차 검증한다.

| resolver | 공식 요지 | 원본 |
|----------|-----------|------|
| `computeThaco` | `thaco_list[class][circle-1] - weaponAdjustment - trunc(profic/mod_profic) - bonus[str]`, circle=`clamp(trunc((level+3)/4),[1,20])`, 최종 3분기 clamp(class<10 & level<101→≥0, level≥101→≥-5, class≥10→≥-10) | `player.c:1001` |
| `maxWeight` | `20 + effectiveStrength*10`, barbarian(class 2)만 `+ trunc((level+3)/4)*10` (이 항은 `[1,20]` clamp **없음**, L≥81 발산) | `player.c:1099` |
| `computeHpMax` | `hpstart + trunc(hp*(level-1)/2)` | `player.c:805` |
| `computeMpMax` | `mpstart + trunc(mp*(level-1)/2)` | `player.c:806` |

### 접근자 clamp·fail-fast 정책

- `bonusOf(score)` — 인덱스를 `[0,63]`으로 clamp 후 조회(항상 안전).
- `thacoOf`·`classStatOf` — 범위 밖 인덱스를 `RangeError`로 거부(무효 입력을 조용히 삼키지 않는다).
- `proficDivisorOf` — 범위 밖이면 원본 switch의 default(40)를 반환.

### 검증 (하이브리드)

- **computeAc** — byte-level C oracle 대조 + 골든 fixture(선행 #73/#79 하네스 재사용).
- **computeThaco·maxWeight·computeHpMax·computeMpMax** — 독립 참조 구현이 생성한 골든 fixture와 SUT를 대조. 참조 구현은 SUT와 의도적으로 다른 표현이라 transcription tautology를 방어하며, 각 골든 테스트는 `+1` 음성 대조로 러너가 실차이를 잡는지 증명한다.
- **상수 테이블** — `global.c`/`player.c` 전사값을 골든 fixture 체크인 diff로 검증.
- **effectiveStat** — 무clamp 가산 불변식을 수동 property 테스트로 검증.

상세 하네스는 `docs/specs/golden-fixture-harness.md`(#73)·`docs/specs/property-testing.md`(#79) 참조.

## 제약사항

- **스키마-중립 순수 라이브러리** — `characterSchema`를 변경하지 않는다. 영속 필드(level·exp·HP/MP·숙련) 추가는 소유 토픽(진행·아이템) 소관이다.
- **상태·영속·스케줄러 없음** — 재생 틱·버프 만료 스케줄러 배선, 레벨업·능력치 성장·승급 로직, 장비 착용/해제 트리거는 범위 밖이다.
- **modifier 소비 전용** — 장비 armor·주문 버프 등 실제 modifier 값 생성은 전투·마법·아이템 소유 토픽이 담당한다.
- **HP/MP는 최대치만** — 현재 HP/MP·데미지 상태·재생은 파생하지 않는다.
- **HP/MP 폐형은 oracle과 부분 발산(수용)** — 원본 `up_level`은 `level%4≠0` 레벨에서 791행 조기 return으로 증분 누적값을 유지하고 4의 배수 레벨에서만 폐형으로 재동기화한다. stats-core는 이 드리프트를 `level%4` 조기 return이 만든 형상 버그로 판단해 깔끔한 폐형 하나만 구현한다 — 발산 레벨에서 원본과 다를 수 있으며 수용된 결정이다(근거: `docs/notes/game-analysis-20260625/a7-player-progression.md` §2).
- **maxWeight barbarian 항 무클램프** — 원본 그대로 재현하며 L≥81에서 소지량이 발산한다.
