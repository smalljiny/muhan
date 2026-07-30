# 캐릭터 P-flag 합성 계층

> 플레이어 상태 플래그의 영속 입력원(`statusEffects`·`buffs`)을 세 투영으로 파생하고 OR해, 소비측이 `F_ISSET`으로 읽는 단일 16자 hex를 만드는 계층.

## 개요

원작 무한/Mordor에서 플레이어는 몬스터와 동일한 `creature` 구조체를 가지며, 모든 상태 플래그가 하나의 `flags[8]`(8바이트 = 64비트) 비트필드에 담긴다(`legacy/muhan/src/mstruct.h:197`). 축복·실명·침묵·은신·소심·혼돈 성향이 모두 같은 배열의 서로 다른 비트다.

이 포트는 그 단일 비트필드를 **분해 영속 + 뷰 투영** 모델로 재설계했다. 비트필드는 만료 시각을 담을 수 없어(오라클은 별도 `lasttime[]` 배열 사용) 타이머 보유 효과를 그대로 hex로 옮길 수 없기 때문이다. 명명 필드가 정본이고 hex는 **항상 파생값**이다.

`characterSchema`에 raw `flags` hex 필드를 두지 않는다. 두면 예컨대 PBLIND(42)가 `statusEffects.blind`와 `flags` 두 곳에서 표현돼 **drift**(한쪽만 갱신되는 이중 출처)가 생긴다.

### 플래그 폭 — 8바이트 / 16자 hex

| 출처 | 값 |
|---|---|
| `legacy/muhan/src/mstruct.h:197` | `char flags[8]` — 8바이트 = 64비트 |
| `packages/port/templates.js` CRT 오프셋 테이블 | `flags: 412`, `hexFixed(b, c('flags'), 8)` |
| `data/world/creatures.json` | 674개 샘플 전부 `flags.length === 16`(hex 문자) |
| `combat/statusEffects.ts`·`magic/buffEffects.ts`의 `ZERO_FLAGS` | `'0000000000000000'` — 16자 |

네 출처가 일치한다. 사용 중 최대 비트는 MNOCHA(62)로 64비트 안에 든다.

## 구조

| 모듈 | 책임 |
|---|---|
| `packages/server/src/character/flags.ts` | `composeCharacterFlags(character, now)` — 세 투영을 OR한 16자 hex 반환. 비트 소유권 파티션의 정본 JSDoc. |
| `packages/server/src/world/hexFlags.ts` | `orFlags(a, b)` 바이트 OR 헬퍼 + `PSILNC`(44)·`PFEARS`(43) 상수. |
| `packages/server/src/combat/statusEffects.ts` | `projectStatusFlags` + silence·fear의 grant/clear/is\*Active 헬퍼. |
| `packages/server/src/magic/buffEffects.ts` | `projectResistFlags`·`projectBuffFlags`(기존). |
| `packages/shared/src/schema/character.ts` | `statusEffects.silence`·`.fear`(`{until}`), `alignment` required. |
| `packages/server/src/repo/characterBackfill.ts` | `backfillCharacterV6` — `alignment` 중립 sentinel 시딩, `CURRENT_CHARACTER_SCHEMA_VERSION = 6`. |

### 모듈 배치 — 순환 의존 회피

`composeCharacterFlags`는 `combat/statusEffects.ts`와 `magic/buffEffects.ts` 양쪽을 소비한다. 현 의존 방향은 `magic → combat`이므로(`debuffEffects.ts`가 `../combat/dice.js`·`../combat/combatant.js`를 import) 합성 함수를 `combat/`에 두면 `combat → magic → combat` 순환이 생긴다.

신규 모듈 `character/flags.ts`가 양쪽을 소비하되 **누구도 이 모듈을 역참조하지 않는다**(배선 계층만 소비). `combat/`·`magic/` 프로덕션 소스는 `character/flags.js`를 import하지 않으며, 투영이 필요한 하위 모듈은 각자의 `project*Flags`를 직접 쓴다. 테스트 파일은 이 제약 밖이다 — 런타임 모듈 그래프에 들어가지 않아 순환을 만들지 않는다.

### 데이터 흐름

```
characterSchema (MongoDB 영속, v6)
  ├─ statusEffects: { poison?, disease?, blind?, silence?, fear? }
  └─ buffs: { "<spellNo>": { until } }
            │
            ├─ projectStatusFlags(character, now)  → hex(16자)
            ├─ projectResistFlags(character, now)  → hex(16자)
            └─ projectBuffFlags(character, now)    → hex(16자)
                        │
                        ▼  orFlags
            composeCharacterFlags(character, now)  → hex(16자)
                        │
        ┌───────────────┼────────────────────┐
        ▼               ▼                    ▼
  toPlayerCombatState   study(char, book)    teach(caster, target, spellNo)
  (…, flags)            F_ISSET(flags,       F_ISSET(flags, PBLIND/PSILNC)
        │               PBLIND)
        ▼
  attackStats: PFEARS +2 / PBLIND +5
```

## 동작

### 비트 소유권 파티션 (서로소·열거)

각 비트의 생산자는 **정확히 하나**다. 세 소유 집합은 서로소이며, 아래 표에 없는 비트는 어떤 입력에서도 세팅되지 않는다. 새 비트는 이 표에 **먼저 등재**한다(표 갱신 → 소유 투영 지정 → 구현 순서).

| 출처 | 영속 필드 | 소유 비트 | 성격 |
|---|---|---|---|
| `projectStatusFlags` | `statusEffects` | PPOISN(16)·PDISEA(41)·PBLIND(42)·PFEARS(43)·PSILNC(44) | 타이머 보유 디버프 |
| `projectResistFlags` | `buffs`(저항 4주문) | PRFIRE(30)·PRMAGI(32)·PRCOLD(36)·PSSHLD(38) | 타이머 보유 저항 버프 |
| `projectBuffFlags` | `buffs`(타이머 10주문) | PBLESS(0)·PINVIS(2)·PPROTE(8)·PLIGHT(17)·PDMAGI(20)·PDINVI(21)·PLEVIT(25)·PFLYSP(31)·PKNOWA(33)·PBRWAT(37) | 타이머 보유 이로운 버프 |
| **(미소유 — 영속 경로 부재)** | 없음 | PHIDDN(1)·PDMINV(10)·PWIMPY(14)·PCHAOS(28)·PFAMIL(55)·PUPDMG(59) | 잠재(비-타이머) 상태 |

`flags.test.ts`가 각 비트가 정확히 한 출처에서만 세팅됨을 검증한다.

**PFEARS·PSILNC 이중 출처 금지.** 두 비트의 생산자는 `projectStatusFlags` 단독이다 — `magic/buffEffects.ts`의 `TIMED_BUFF_META`에 SFEARS/SSILNC를 추가하지 않는다. 소유 비트 정확일치 테스트만으로는 **등재 추가** 드리프트를 못 잡으므로, `flags.test.ts`가 SFEARS·SSILNC buffs 엔트리를 직접 활성화해 아무 비트도 서지 않음을 고정하는 회귀 케이스로 강제한다.

### ⚠ 미소유 행은 "아직 안 함"이 아니라 구조적으로 봉쇄된 상태다

raw `flags` hex 영속 필드를 두지 않는 것이 이 계층의 규약인데, 미소유 비트들은 `statusEffects`·`buffs` 어디에서도 파생되지 않는 **비-타이머 성격**이라 현 아키텍처에 영속 경로 자체가 없다. 즉 `composeCharacterFlags`는 이 비트들을 **영원히 0으로 반환한다**.

그럼에도 소비자가 이미 존재한다:

| 소비처 | 읽는 비트 | 봉쇄되는 동작 |
|---|---|---|
| `combat/pvp.ts` `checkPvpGate` | PCHAOS(28) | 전원이 "비 PCHAOS = 선"으로 판정돼 선악 게이트 분기가 한쪽으로 고정 |
| `combat/pvp.ts` `checkPvpGate` | PFAMIL(55) | "양측 패거리" 조건이 성립하지 않아 주입된 `checkWarResult` seam이 판정에 반영되지 않음 — 패거리 평화 carve-out이 사문화 |
| `combat/aggro.ts` `selectAggroTarget` | PHIDDN(1)·PDMINV(10) | 은신·DM투명 대상의 aggro 제외가 미발화(같은 함수가 읽는 PINVIS는 `projectBuffFlags` 소유라 정상 동작) |

후속 배선 토픽이 이 표를 "flags의 완전한 출처"로 읽고 `PlayerCombatState.flags`에 합성 hex를 **유일 출처로** 배선하면 위 동작이 조용히 봉쇄된다. **현재 `flags: ''`라 동작이 동일해 회귀로 드러나지 않는다는 점이 이 함정의 핵심이다.** 미소유 비트의 영속 표현(전용 명명 필드 vs raw hex 예외)은 배선 **전에** 결정해야 한다.

### `orFlags` — 폭 보존 불변식

합성은 16자 hex 세 개를 OR한다. 헬퍼가 `Math.min(a.length, b.length)`까지만 순회하면 짧은 피연산자에서 **고바이트가 조용히 잘린다** — PBLIND(42)·PFEARS(43)·PSILNC(44)가 전부 byte 5(문자 인덱스 10-11)에 있어 정확히 이 절단에 걸린다.

`orFlags`는 **8바이트를 고정 순회**한다. `byteAt`이 범위 밖을 0으로 돌려주므로 짧은 입력은 자연히 0바이트가 되고, 반환 폭은 입력과 무관하게 항상 16자다. 반대 방향(16자 초과)은 byte 8 이후를 절단한다 — P/M/O-flag가 전부 `char flags[8]`이라 실 데이터가 이 경계를 넘지 않는다.

원작 `mtype.h` 매크로가 아닌 포트 고유 헬퍼라 `F_` 접두를 쓰지 않는다(원작은 flags가 고정 8바이트 배열이라 폭 문제 자체가 없다).

### 캐시 없음

`composeCharacterFlags`는 캐시·메모이제이션 없는 순수 함수다. 결과는 `(character, now)`의 함수이고 `now`는 매 틱 변하므로, 캐시를 두면 만료 경계에서 stale 비트를 돌려주고 **무효화 규칙이 곧 재계산과 같아진다**. 만료된 효과는 각 투영이 이미 제외하므로 합성 지점에서 별도 만료 판정을 하지 않는다.

### `toPlayerCombatState` — flags를 인자로 받는다

```ts
toPlayerCombatState(character, effectiveContext, weaponDamage, flags: string): PlayerCombatState
```

조립 헬퍼는 합성하지 않고 hex를 **인자로만** 받는다. 호출부(배선 계층)가 `composeCharacterFlags(character, now)`를 계산해 주입한다. 두 가지 이유다:

1. `now` 의존성을 조립 헬퍼 밖에 두면 헬퍼가 시간에 무관한 순수 매핑으로 남는다 — `debuffEffects`가 절대 시각이 아니라 상대 `dur`만 보고하고 `now+dur` 계산을 배선 계층에 넘기는 선례와 동형이다.
2. 의존 방향 규약(위 §순환 의존 회피).

`PlayerCombatState.flags`는 **조립 시점 스냅샷**이며 `readonly`다 — 라운드 중 in-place mutation 경로를 두지 않는다. 만료로 비트가 내려가야 하면 재조립이 정본 경로다.

### 영속 표현 — `statusEffects.silence`·`.fear`

`{ until: z.int().min(0) }`(`untilOnlyEffectSchema`, blind와 공용). 오라클에서 둘 다 dur를 보유하므로(silence는 CAST=3600 고정, fear는 표준 디버프 공식) `{until}`이 정확한 표현이고, 주기 피해가 아니라 `interval`을 갖지 않는다(blind 선례).

`untilOnlyEffectSchema`는 셰이프가 `buffEntrySchema`와 같지만 **상수를 공유하지 않는다** — `buffs`와 `statusEffects`의 결합 표면을 분리한 결정에 따라 두 계약은 독립적으로 진화할 수 있어야 한다.

`grantSilence`/`grantFear`/`clearSilence`/`clearFear`/`isSilenceActive`/`isFearActive` 순수 헬퍼를 blind 대칭으로 제공한다. 전부 입력 `Character`를 변형하지 않고 새 객체를 반환한다.

### `alignment` — required 승격

`alignment: z.int()`(required). 학습 게이트와 전투 상태가 매 판정마다 값을 요구해, 부재를 허용하면 소비 지점마다 폴백이 흩어진다. `toPlayerCombatState`의 기존 `alignment ?? 0` 폴백을 제거하고 폴백 출처를 backfill 한 곳으로 고정했다.

**값역 제약(`.min().max()`)을 두지 않는다.** 현재 실 값역 `[0,2]`(생성 인터뷰 1|2 + backfill sentinel 0)는 **한시적 인코딩**이다 — 오라클의 alignment는 부호 있는 int16이고(`port/templates.js`의 `readInt16LE`) 소비 규칙들이 이미 그 스케일의 임계값을 보존하고 있다. `.min(0).max(2)`를 걸면 (a) 부호가 목표 인코딩과 충돌하고 (b) 레거시 세이브 이식·E6 부분 롤아웃 시 문서가 로드 불가가 된다. 영속 경계는 인코딩 전환을 살아남아야 하므로 도메인은 상류(`sessionFsm`의 `refine(1|2)`)가 강제하고 스키마는 정수형만 본다.

### alignment 게이트 4곳의 known-divergence

값역 `[0,2]`에서 미발화하는 alignment 게이트는 4곳이다. **전부 주석만 추가했고 임계값은 손대지 않았다.**

| 위치 | 게이트 | 오라클 임계값 | `[0,2]`에서의 결과 |
|---|---|---|---|
| `magic/learning.ts` | study OGOODO/OEVILO | `< -100` / `> 100` | 두 분기 모두 거짓 — 정렬로 연마를 거부당하는 캐릭터 없음 |
| `combat/aggro.ts` | MGAGGR/MEAGGR 선공 | `< 100` / `> -100` | 두 조건 모두 참 → early-return — 해당 몹이 아무도 선공하지 않음 |
| `combat/attackStats.ts` | PALADIN 정렬 보정 | `< 0` / `> 250` | 두 분기 모두 거짓 — 항상 `n` 반환 |
| `items/flags.ts` | `alignmentAllowed` 착용 | `< -50` / `> 50` | 두 조건 모두 거짓 — 정렬 착용 제한 미발화 |

**임계값을 현 값역에 맞춰 재조정하지 않는다.** 오라클 상수를 보존하면 E6가 `-1000..+1000`을 도입할 때 **코드 변경 없이** 네 게이트가 동시에 발화한다. "고치면" 오라클 상수가 소실되고 E6에서 값 재해석이 필요해진다. 이를 "정렬 게이트 수정"으로 보고하지 않는다.

### `ActorContext.flags` 타입

`readonly flags?: readonly string[]` → `readonly flags?: string`으로 정정했다. 이 포트의 플래그 정본 표현은 hex **문자열**이며 `F_ISSET(hex, bit)`로 판독한다 — PBLIND(42)·PFEARS(43)·PSILNC(44)가 비트 인덱스 > 31이라 number bitfield로도 담을 수 없다.

방 flags(`number[]`, `door.ts`의 `hasFlag`가 소비)와는 별개 표현이다. `buildActorContext`가 이 필드를 채우지 않고 읽는 코드도 0건이라 정정 파급이 없다 — **잘못된 타입을 남겨 두면 후속 배선이 배열을 채우는 함정이 되므로** 미배선 상태에서 타입만 먼저 바로잡았다.

## 제약사항

- **명령 배선 미포함** — teach(#119)·study(#120)·attack(#121) 명령의 파싱·대상 해소·broadcast·응답 메시지는 각 배선 토픽 소관이다. 이 계층은 그들이 소비할 입력원과 합성 경로만 세운다.
- **플레이어 대상 디버프 부여 경로 미배선** — `magic/debuffEffects.ts`는 `target.kind !== 'creature'`에서 전면 유예 중이다. 플레이어에게 침묵·공포를 **거는** writer는 이 계층 밖이며, 여기서는 값이 안착할 영속 필드와 판독 경로만 제공한다.
- **미소유 비트의 영속처 부재** — PHIDDN·PDMINV·PWIMPY·PCHAOS·PFAMIL·PUPDMG. 위 봉쇄 경고 참조.
- **E6 성향 시스템 미포함** — alignment 값 체계 확장, 성향 증감 규칙(살해·PvP), 4개 게이트의 실발화는 [#123](https://github.com/smalljiny/muhan/issues/123) 소관이다.
- **`ActorContext.flags` 실 값 주입 미포함** — 타입만 정정하고 `buildActorContext`의 미충전 상태는 유지한다([#106](https://github.com/smalljiny/muhan/issues/106) 소관).
- **몬스터 M-flag 경로 무변경** — `CreatureInstance.flags`는 이미 라이브 hex를 보유한다.
- **`statusEffects.blind`의 영구 실명 표현 미결** — 오라클의 `blindEffect`는 dur를 부여하지 않으나(개안술 전까지 영구) 스키마는 `until`이 필수다. sentinel 관례는 플레이어 실명 부여 writer가 생기는 배선 토픽으로 넘긴다. 침묵·공포는 실 dur이 있어 이 문제가 없다.
- **`flags` 스냅샷 재조립 시점 미결** — 전투 라운드 루프에서 언제 재조립할지(매 라운드 vs 만료 이벤트 시)는 배선 토픽(#121) 소관이다.

## 관련 문서

- [persistence.md](persistence.md) — `characterSchema` 필드 표, v6 backfill 체인
- [combat.md](combat.md) — `toPlayerCombatState`, 명중 임계 PFEARS/PBLIND, PALADIN 정렬 보정
- [magic-progression.md](magic-progression.md) — study·teach 게이트, `statusEffects` 헬퍼
- [items-equipment.md](items-equipment.md) — `alignmentAllowed` 착용 게이트
- [save-policy.md](save-policy.md) — `STATUS_EFFECT_COPIERS` 스냅샷 복사
- [account-character.md](account-character.md) — 생성 인터뷰 스칼라와 `alignment` required
