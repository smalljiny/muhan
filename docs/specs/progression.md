# 진행 루프 (Progression)

> 무한 플레이어 진행 파이프 — 경험치 곡선·명시 연마 레벨업·능력치 성장·HP/MP 최대치 compute-on-read·HP/MP 재생·PvE 사망 페널티·무적/초인 승급. 원본 동작을 충실히 재현하되 결정적 순수 변이 + WorldClock 슬롯으로 재구현한다.

## 개요

무한의 플레이어 진행은 자동이 아니다. 경험치는 몬스터 처치·퀘스트로 누적되지만 **레벨업은 `연마`(train) 명령으로만** 발생한다 — 수련장(`RTRAIN` 방)에서 직업 매칭·경험치 임계·gold를 모두 충족해야 승급한다. 능력치는 4레벨 주기로만 성장하고, HP/MP는 5초 틱으로 재생하며, 사망은 exp를 깎되 레벨은 유지한다. 최상위는 승급(무적 L100 리셋·초인 L127 고정)으로 이어진다.

이 도메인은 stats-core(#80) 파생 스탯 폐형 resolver의 첫 진행-측 소비자이자, runtime-foundation(#67) WorldClock `register` seam의 첫 실소비자(재생 5초 슬롯)다. 새 스케줄러·새 스탯 공식을 만들지 않고 확정된 seam에 얹는다.

진행은 **결정적**이다 — exp·레벨업·성장·재생·사망 페널티에 확률 굴림이 없고 RNG 주입 seam도 없다(전투 데미지는 #82 소관).

원본 동작 명세(oracle): `command7.c`(연마)·`player.c`(재생·성장)·`creature.c`(사망)·`global.c`(needed_exp·level_cycle 테이블)·`mtype.h`(class enum·방 플래그).

## 구조

순수 로직은 `packages/shared/src/progression/`, 런타임 seam 소비는 `packages/server/src/progression/`에 둔다(순수성 경계).

| 파일 | 소유 | 역할 |
|------|------|------|
| `shared/progression/tables.ts` | shared | `needed_exp[128]`·`level_cycle[13][10]` oracle 전사 테이블 |
| `shared/progression/expCurve.ts` | shared | `neededExp(level)`(테이블+L127 초과 선형)·`expToLevel(exp)`(역함수) |
| `shared/progression/maxResolvers.ts` | shared | `resolveHpMax`/`resolveMpMax`(compute-on-read)·`clampVital` |
| `shared/progression/levelUp.ts` | shared | `upLevel(char)`/`downLevel(char)` 순수 변이(능력치 성장·최대치 재동기화) |
| `shared/progression/prestige.ts` | shared | `classifyPrestige`·`invinciblePrestige`·`caretakerPrestige` |
| `server/progression/train.ts` | server | `연마` 3게이트 핸들러(location→exp→gold)·prestige 디스패치·배치 upLevel |
| `server/progression/regen.ts` | server | `regenVitals` 순수 + `createRegenSlot`(WorldClock `intervalSec:5` 슬롯) |
| `server/progression/death.ts` | server | `applyPlayerDeath` PvE 사망 페널티 순수 소비자 |
| `shared/oracle/fixtures/needed_exp.json`·`level_cycle.json` | shared | 골든 fixture(전사+독립 참조+하드 리터럴 앵커) |

**영속 슬라이스**: 진행 변이가 쓰는 필드는 `level`·`experience`·`gold`·`stats`(5튜플 STR/DEX/CON/INT/PTY)·`hpCurrent`/`mpCurrent`·`class`. `experience`가 **유일한 신규 영속 필드**(required, `schemaVersion` 2→3 backfill), 나머지는 기존 필드 변이. `level`/`hpCurrent`/`mpCurrent` 필드 정의는 combat-resolve(#82) 소유이며 여기선 변이만 한다. **HP/MP 최대치는 저장하지 않는다** — compute-on-read.

## 스키마: experience 필드

`characterSchema`에 `experience: z.int().min(0)`을 **required**로 추가한다(`.optional`/`.default` 미채택 — undefined가 progression 전 로직에 새면 모든 소비자가 처리해야 하므로). `schemaVersion`을 combat-resolve v2 위 2→3으로 bump하고, characterRepository load 경로(`findById`/`findByAccount`)의 **parse 직전** raw 문서에 `backfillCharacterV3`을 삽입한다(`z.strictObject`가 필드 누락 문서를 parse 거부하므로 backfill이 parse 이전 실행 필수).

backfill 시딩은 level 정합: `level<=1 ? 0 : neededExp(level-1)`(그 레벨 도달에 최소 필요한 누적 exp, death exp-floor와도 정합). 신규 캐릭터는 생성 경로에서 `experience: 0` 시딩.

## 동작

### exp 곡선

`neededExp(level)` — `level≤128`: `needed_exp[level-1]`; `level>128`: `needed_exp[126] + (level-127)×5,000,000`(선형 확장). `neededExp(L)`은 L→L+1 승급 임계다. `expToLevel(exp)`는 `needed_exp` 선형 스캔으로 exp가 충족하는 최대 레벨을 반환(사망 클램프 소비). `needed_exp` 값은 골든 fixture로 검증한다(`neededExp(1)===128`·`neededExp(128)===190,000,000`·`neededExp(129)===110,000,000` 등 하드 리터럴 앵커).

### 명시 연마 (train)

`연마` 명령은 3게이트를 순서대로 판정한다:

1. **위치 게이트** — 방 `RTRAIN`(비트 3) 필수. 클래스 매칭: `bit[i]=(class-1)&(1<<i)`(i=0..2)를 방의 `RTRAIN+3-i`(비트 6/5/4, **역순**)와 대조, 불일치면 실패. `class≥무적(9)`은 클래스 서브매칭 면제(base `RTRAIN`은 필수). `초인(10)`은 연마 금지. (help/rflags의 `RTRAIN=4`는 off-by-one이라 무시 — mtype.h·컴파일 코드의 3이 정본.)
2. **exp 게이트** — `experience ≥ neededExp(level)`.
3. **gold 게이트** — `gold ≥ goldToTrain(level)`. `goldToTrain(level) = trunc(neededExp(min(level, 127)) / 20)` — `level<128`은 `trunc(neededExp(level)/20)`, **`level≥128`은 `trunc(neededExp(127)/20)=5,000,000`으로 clamp**(오라클 command7.c:595-596). exp 게이트의 expNeeded는 clamp 없이 선형 확장하므로 별개다.

세 게이트 통과 시: **prestige 우선 분기**(train 진입 시 1회 평가) — 승급 대상이면 gold 차감 후 전이하고 종료(배치 루프 스킵). 아니면 **배치 do-while 루프**: gold 차감 → `upLevel` → 다음 임계 재계산, `neededExp≤experience && goldToTrain≤gold`인 동안 반복. 일반직(`class<9`)은 정확히 `level===100`에서 정지(다음 연마에서 무적 승급); 무적(`class 9`)은 exp/gold 소진까지 상승. train은 exp를 깎지 않는다 — 레벨만 오르고 임계가 올라가 결국 종료한다. 성공 시 새 Character를 반환하고 최종 스냅샷을 markDirty로 1회 기록(입력 무변이).

### 능력치 성장 vs 최대치 재계산 (분리)

원본 `player.c` 공유 조기 return이 두 규칙을 하나처럼 보이게 하나, 분리한다:

- **능력치 성장**: `upLevel`이 **`level%4==0`일 때만** `level_cycle[class][(level-2)%10]` 대상 능력치를 +1. `downLevel`은 정확한 역연산(강등 레벨이 `%4==0`였으면 -1). `level_cycle` 성장 분포는 골든 fixture로 검증.
- **HP/MP 최대치 재계산**: `%4` 게이트 없이 **매 판독마다** compute-on-read. `resolveHpMax(char)`/`resolveMpMax(char)`가 `class`·`level`로 stats-core `computeHpMax`/`computeMpMax` 폐형에 위임(능력치는 최대치 산출에 불필요). `class===초인(10)`이면 800/600 고정 오버라이드, INVINCIBLE(9)은 폐형(400+성장)을 따른다. 원본 `%4` 증분 누적은 stats-core가 형상버그로 폐기한 정책을 승계한다.

`hpCurrent ≤ resolveHpMax` 불변식은 `clampVital(current, max)=Math.min`로 유지한다(레벨업·강등·재생·승급 공유 소비). 정상 레벨업은 `hpCurrent`를 올리지 않고 최대치 하락 시 클램프만 한다(재생이 격차를 메운다).

### HP/MP 재생

WorldClock `register`에 `intervalSec:5` 슬롯 1개(`createRegenSlot`). 정상 방 재생량(oracle player.c:589-604):

- `hpCurrent += MAX(4, 5 + bonusOf(con) + (class===권법가(2) ? 2 : 0))`
- `mpCurrent += MAX(4, 5 + (int>17 ? 1 : 0) + (class===도술사(5) ? 2 : 0))`
- 각각 `resolveHpMax`/`resolveMpMax`로 클램프. con=stats[2], int=stats[3].

`RHEALR`(회복실, 비트 13) 방은 정상 재생 후 hp/mp 각 **+100 진폭** 적용 후 최종 클램프(순서: 정상재생 → RHEALR +100 → 클램프 1회). 슬롯은 활성 플레이어를 순회하며 라이브 char를 carve-out으로 in-place 갱신하고 distinct 스냅샷을 markDirty로 흘린다(dirtyTracker 계약). provider는 주입 seam이며 기본값은 빈 iterable(dormant) — 라이브 플레이어 집합의 실 소스는 #82 combatRegistry + 유예된 lifecycle wiring이다.

### PvE 사망 페널티

`applyPlayerDeath(char, { reviveRoom })` 순수 소비자 — HP<1 사망 판정(발화는 #82 전투)이 호출할 seam을 정의만 한다(index.ts 미배선). 처리:

- **exp 손실**: `level<20`이면 `trunc(experience/20)`(5%); `level≥20`이면 `min(trunc(experience/15), 100,000)`(10만 캡). 이후 `max(0, ·)`.
- **레벨 유지**: 깎인 exp가 레벨 임계 아래로 내려가면 하한 `expFloor(level) = level<=2 ? 0 : neededExp(level-2)`로 되끌어올린다(`level≤2`는 인덱스 OOB 가드로 0). `level` 필드는 변경하지 않는다.
- **부활·회복**: `currentRoom = reviveRoom`(주입 상수, 기본 1008), `hpCurrent = resolveHpMax`(부활 풀회복), `mpCurrent = resolveMpMax`(몬스터 피살 풀회복).

### 승급 (prestige)

`class` 값 전이로만 표현한다(별도 prestige 필드 없음). `classifyPrestige(char)`가 `'invincible' | 'caretaker' | 'none'`을 반환하고 train이 배치 루프 전에 소비한다.

- **무적(INVINCIBLE)**: `level===100 && class<9` → `class=9`·`level=1`·`experience=0` 리셋, `hpCurrent=resolveHpMax`·`mpCurrent=resolveMpMax`.
- **초인(CARETAKER)**: `level≥127 && class===9` → `class=10`·`level=127` 고정, 최대치 resolver가 800/600 오버라이드로 산출한 값으로 채움.

## 제약사항

- **HP/MP 최대치 미저장** — 저장하지 않고 compute-on-read. 최대치 재계산 goal은 on-read 계산으로 재해석한다(D2).
- **RHEALR `interval/=3` 케이던스 가속 미구현** — 진폭(+100)만 재현. WorldClock 슬롯의 `intervalSec`는 정수·전 플레이어 공유 상수라 방별 서브-5초 케이던스를 표현할 수 없다. per-player/per-room 스케줄러 도입 후속 토픽으로 이월.
- **오라클 상태 guard 미구현** — 재생의 `RPHARM`/질병/독(`!ill && !PPOISN`), 연마의 `PBLIND`/`PUPDMG`, 사망의 독/질병 해제(`PPOISN`/`PDISEA`)는 characterSchema에 상태 플래그 필드가 없어 통째 생략한다(DoT는 #83 소관). 상태 플래그가 스키마에 붙는 후속 토픽에서 함께 이식한다.
- **오라클 대비 의도된 발산**: 정상 레벨업 `hpCurrent` 미상승(원본 `%4` 풀회복 비재현, 재생이 채움); 사망 시 `down_level` 미호출·레벨 유지(오라클은 down_level 호출, A7 §11 재해석); 무적 리셋이 `level=1`에서 종료(원본 fall-through +1 비재현).
- **seam 미배선** — train·regen·death는 라이브 command/tick 디스패처에 아직 배선되지 않았다(regen provider는 dormant). cross-topic 접합면 X1(death seam 발화·배선)·X2(level 변경 후 라이브 투영 refresh·초인 4d4+4 주사위)·X3(hpCurrent/mpCurrent 이중 홈 sync)은 #82 combat-resolve 표면 확정(rebase) 시점의 조정점으로 남긴다.
- **write-path 조정(deferred)** — train·regen은 full Character 스냅샷을 markDirty한다. dirtyTracker가 키당 full 스냅샷 last-write-wins 교체라, bank 직접 write·#82 이중 홈 같은 out-of-band DB write를 이후 flush가 무성 revert할 수 있다(특히 regen은 반복 writer). field-ownership/versioning 병합 계약은 caller-wiring 토픽(#43) 소관이며, seam 미배선인 현재는 도달 불가하다.
- **범위 밖**: DoT(독/질병)·PvP 사망 특수·사망 exp 분배(→#83), gold 소싱(→#87), 마법 데미지(→#84/#85), 직업전환(`chg_class_main`), 전투 데미지(→#82).

## 관련 문서

- `docs/specs/stats-core.md` — 파생 resolver(`computeHpMax`/`computeMpMax`)·oracle 전사 정책·`%4` 폐기 근거(소비 대상).
- `docs/specs/runtime-foundation.md` — WorldClock `register` seam(재생 슬롯 배치 지점).
- `docs/specs/save-policy.md` — SaveEngine write-behind·dirtyTracker 계약(진행 변이 영속).
- `docs/specs/golden-fixture-harness.md` — 골든 fixture 전사+독립 참조 관례(needed_exp·level_cycle).
- 이슈 #81(진행 루프)·#82(combat-resolve, 필드 경계·X1/X2/X3)·#43(write-path 조정)·#83(DoT·PvP 사망).
