# magic-progression — 마법 지속·성장 (spell store·학습·성장·타이머·비-offensive effect)

> #84가 유예한 마법 계층의 나머지 절반 — 플레이어 spell store·학습/전수·realm 숙련 성장·버프/디버프 타이머·비-offensive effect 36종·몬스터 self-heal(E6b-2, 이슈 #85)

## 개요

#84(`docs/specs/magic.md`)는 CAST delivery·공격 effect 20종·시전 게이트·몬스터 시전 seam을 이식했지만, 플레이어에 spell store가 없어 `Caster.realm=[0,0,0,0]`·`knows=false`를 forward-compat stub으로 반환했다. 이 계층은 그 stub을 **실 플레이어 spell store**(characterSchema v5)로 대체하고, 카탈로그에 메타데이터만 있던 비-offensive 주문 36종에 실 effect 본체를 부여해 마법 계층을 완결한다.

범위는 **순수 로직 + seam**이다. 지식 비트마스크 read/write, realm 성장 산식, 버프/디버프 dur 산식, effect 핸들러는 전부 순수 함수로 이식하고, 라이브 command 라우팅(`cast`/`study`/`teach`)·production boot 배선·아이템 delivery는 후속 토픽(#106·#99·#86)에 넘긴다.

## 구조

| 위치 | 모듈 | 책임 |
|------|------|------|
| `packages/shared/src/schema/character.ts` | (기존 확장) | `spells`·`realm`·`buffs` 필드, `schemaVersion` 5 |
| `packages/shared/src/magic/spellStore.ts` | — | `isKnown`/`setKnown` 비트마스크 헬퍼(S_ISSET/S_SET 대응) |
| `packages/shared/src/magic/buffCatalog.ts` | — | 버프/디버프 dur 공식 선언 메타(`BUFF_DUR_META`·`DEBUFF_DUR_META`) |
| `packages/server/src/repo/characterBackfill.ts` | (기존 확장) | `backfillCharacterV5`·`seedSpellStore`·`CURRENT_CHARACTER_SCHEMA_VERSION=5` |
| `packages/server/src/magic/caster.ts` | (기존 확장) | `toCaster(player)`가 실 store(`state.spells`/`state.realm`) 반환 |
| `packages/server/src/combat/playerState.ts` | (기존 확장) | `PlayerCombatState`에 `spells`·`realm` 필드 스레딩(`toPlayerCombatState`가 `Character`에서 이식) |
| `packages/server/src/magic/learning.ts` | — | `study`·`teach` 순수 함수 + `canTeachSpllv` 전수등급 판정 |
| `packages/server/src/magic/realmGrowth.ts` | — | `realmGrowthAmount` — realm 숙련 성장량 순수 산식 |
| `packages/server/src/magic/offensiveSpell.ts` | (기존 확장) | `applySpellDamage`가 realm 성장량을 `SpellDamageOutcome.realmGrowth`로 보고 |
| `packages/server/src/magic/spellDuration.ts` | — | `computeBuffDur`/`computeSpecialBuffDur`/`computeDebuffDur`/`grantBuff`/`isExpired`/`isBuffActive` |
| `packages/server/src/magic/dispatch.ts` | (기존 확장) | `SpellDispatch.register`/`resolve`가 family-agnostic(비-offensive 등록 허용) |
| `packages/server/src/magic/buffEffects.ts` | — | 저항 버프(G5) + 타이머 보유 버프/감지/비행/발광(G7) effect |
| `packages/server/src/magic/debuffEffects.ts` | — | 디버프 6종(G6) pure-report effect |
| `packages/server/src/magic/instantEffects.ts` | — | 즉발 회복/해제/seam(G7) effect |
| `packages/server/src/combat/statusEffects.ts` | (기존 확장) | `clearPoison`/`clearDisease`/`clearBlind` — cure effect 소비 대상. 이후 `grantSilence`/`grantFear`/`clearSilence`/`clearFear`/`isSilenceActive`/`isFearActive`가 blind 대칭으로 추가됐다(판독만 배선, 시전 경로 미배선 — [character-flags.md](character-flags.md)) |
| `packages/server/src/magic/crtSpell.ts` | (기존 확장) | `isSelfTargetSpell`·`castSelfHeal` — 몬스터 self-target 치유(G8) |
| `packages/shared/src/oracle/` | `generators/*Fixture.ts`+`fixtures/*.json` | 골든 fixture — spell store·spllv·addrealm·buff/debuff dur |

## 스키마 (spell store)

`characterSchema`가 `schemaVersion` 4→5로 오르며 필드 3종을 도입한다.

- **`spells`**: `z.array(z.int().min(0).max(255)).length(16)`, required — 128비트 지식 비트마스크(A6 §8 `spells[16]`). 비트 f = 주문번호 f 습득 여부.
- **`realm`**: `z.tuple([int,int,int,int])`(각 `min(0)`), required — 흙/바람/불/물 계열 누적경험치(mstruct.h:195).
- **`buffs`**: `z.strictObject(...).partial().optional()` — 키는 `SPELL_CATALOG` 전체(0-55)에서 파생한 문자열 주문번호, 값은 `{ until: z.int().min(0) }`(strictObject, `interval` 없음 — 버프는 주기 효과가 아니다). `statusEffects`와 병렬 필드로 두되(D2) `until` 관례는 동일하다. optional이며 backfill이 시딩하지 않는다.

`backfillCharacterV5`는 v4 이하 문서를 승격할 때 `spells`=16바이트 0, `realm`=`[0,0,0,0]`으로 시딩하고(`seedSpellStore()`), `buffs`는 시딩하지 않는다(`statusEffects` v4 무시딩 선례). `schemaVersion>=5` 문서는 재시딩 없이 통과한다. `createCharacter` 생성 경로는 동일 `seedSpellStore()`를 공유해 버전 드리프트를 막는다.

`isKnown(store, spellNo)`/`setKnown(store, spellNo)`(`spellStore.ts`)가 C 매크로 `S_ISSET`/`S_SET`을 대응 이식한다 — 바이트 오프셋 `spellNo>>3`, 비트 위치 `spellNo&7`. `setKnown`은 입력을 변형하지 않고 새 `number[]`를 반환한다. `toCaster(player)`는 이제 이 헬퍼를 실 store에 적용해 `knows(spellNo)`를 판독하고, `realm`은 `state.realm`을 그대로 반환한다 — 더 이상 `[0,0,0,0]`/`false` stub이 아니다. `Caster` 계약 필드 수(6개)는 변경되지 않는다.

## 동작

### G2 — 학습·전수

`study(char, book)`(`learning.ts`)는 비법서(SCROLL) 연마를 게이트 순서대로 평가한다: PBLIND(실명) → 오브젝트 타입(SCROLL 아님) → 레벨(`book.ndice > level`) → 정렬(`OGOODO`이고 `alignment<-100` 또는 `OEVILO`이고 `alignment>100`) → 클래스(`OCLSEL` 켜져 있고 해당 클래스 비트 없고 `class<CARETAKER`) → `magicpower` 유효성(카탈로그 밖이면 `no-spell`). 통과 시 `setKnown(char.spells, book.magicpower-1)`한 새 store를 반환하고, 실패 시 원본 store를 그대로 반환한다.

study의 **정렬 게이트는 known-divergence로 미발화**다 — `alignment` 실 값역이 `[0,2]`(생성 인터뷰 1|2 + backfill 중립 sentinel 0)라 `<-100`·`>100` 두 분기가 모두 거짓이고, 현재 어떤 캐릭터도 정렬로 연마를 거부당하지 않는다. 오라클 임계값을 **재조정하지 않는다** — 보존해야 E6 성향 시스템([#123](https://github.com/smalljiny/muhan/issues/123))이 `-1000..+1000`을 도입할 때 코드 변경 없이 발화한다. 같은 성격의 미발화 게이트가 `combat/aggro.ts`·`combat/attackStats.ts`·`items/flags.ts`에도 있다([character-flags.md](character-flags.md)).

study·teach가 읽는 PBLIND·PSILNC의 **영속 입력원은 `characterSchema.statusEffects`**이며, `composeCharacterFlags`가 세 투영을 OR해 소비측이 `F_ISSET`으로 읽는 16자 hex를 만든다([character-flags.md](character-flags.md)). `study` 배선(#120)이 그 합성값을 게이트에 주입한다(`teach`는 #119 대기).

### `progress:study` 라이브 배선 (#120)

`ws/handlers/study.ts`가 순수 `study()`를 명령 경로에 얹는다. 핸들러는 게임 규칙을 재구현하지 않고 **조회·합성·사상·마킹**만 한다.

1. 행위자의 라이브 엔트리를 레지스트리에서 꺼낸다(대상 스코프가 행위자 소지품으로 닫힌다 — 오브젝트 id를 와이어로 받지 않으므로 타 캐릭터 오브젝트 접근 경로가 없다).
2. `resolveCarriedObject`로 `target`·`ordinal`을 인벤 스코프에서 해소한다([`items-equipment.md`](items-equipment.md)). 관찰자 flags는 `composeCharacterFlags(character, now)`로 합성해 넘긴다.
3. 해소된 쌍의 템플릿을 `study()`에 넘겨 게이트를 평가하고, 실패 갈래를 `Record<Failure, string>`으로 한국어 거부 메시지에 사상해 `error{rule_rejected}`로 답한다.
4. 성공 시 라이브 엔트리를 `{ ...live, character }`로 교체하고, `markCharacterDirty` → `markObjectDeleted` 순서로 두 write를 마킹한 뒤(순서 계약은 [`save-policy.md`](save-policy.md)) `progress:studied`를 본인에게 1회 발화한다.

정렬 게이트가 미발화이므로(위 divergence) 현재 라이브 경로에서 정렬로 연마가 거부되는 일은 없다.

`teach(caster, target, spellNo)`는 PBLIND → PSILNC → base-class(`CARETAKER`/`MAGE`/`CLERIC`만 통과, `INVINCIBLE`·`SUB_DM`·`DM`은 불가) → 주문 존재(`spellByNo`) → 시전자 지식(`isKnown`) → `spllv` 전수등급 순서로 평가한다. `canTeachSpllv(casterClass, spllv)`는 등급별 최소 클래스를 판정한다: spllv 1(`CLERIC`↑)·2(`MAGE`↑)·3(`INVINCIBLE`↑)·4(`CARETAKER`↑)·5(`SUB_DM`↑). base-class 게이트가 `INVINCIBLE`·`SUB_DM`을 막으므로 spllv 5 주문은 실질 전수 불가한 quirk가 남는다(원작 충실). 통과 시 `setKnown(target.spells, spellNo)`한 새 store를 반환한다.

두 함수 모두 순수 함수다 — 비법서 소멸·낙하·전수 broadcast 같은 부수효과는 라이브 라우팅(#106) 소관이다.

### G3 — realm 숙련 성장

`realmGrowthAmount(m, exp, hpmax) = min(trunc(m*exp/max(1,hpmax)), exp)`(`realmGrowth.ts`, magic1.c:1122-1130)는 combat `deathDistribution`의 기여자 exp 공식과 동형이다. `offensiveSpell.applySpellDamage`(5단계)가 creature 대상일 때만(`target.kind==='creature'`, PvE 가드) 오버킬 캡 `m`·대상 `experience`·`hpmax`로 이 함수를 호출해 `SpellDamageOutcome.realmGrowth`로 성장량을 보고한다. `caster.realm[]`에 대한 실 write는 하지 않는다 — 성장량 스칼라만 반환하고, 실 write는 라이브 조립(#99)이 `markDirty` seam으로 소비한다. 자기대상·PLAYER 대상(PvP)은 이 블록에 도달하지 않아 성장이 0이다.

### G4 — 지속효과 타이머

버프/디버프 만료는 `statusEffects.until`과 동일한 **절대-틱** 관례를 따른다. `isExpired(until, tick) = tick > until`(`spellDuration.ts`)이 `statusEffects.isActive(until>=now)`의 대우다 — 경계 `tick===until`은 아직 활성이다. `grantBuff(character, spellNo, until)`은 `character.buffs`에 `{ [spellNo]: { until } }`을 병합한 새 `Character`를 반환한다(재-grant는 덮어쓰기). `isBuffActive(character, spellNo, tick)`는 `combat/statusEffects.isActive`를 그대로 위임한다.

`computeBuffDur(spellNo, input)`은 A6 §6 표준 공식 `MAX(300, 1200 + intBonus*600)`에 클래스 보너스(`classBonusClasses`면 `+60*trunc((level+3)/4)`)·RPMEXT 방 보너스(`+rpmext`, 표준 800/detect·fly 600)를 가산한다. `gated=false`(비-CAST)면 고정 1200(`NON_CAST_BUFF_DUR`)을 반환한다. `BUFF_DUR_META`에 등록된 표준 11주문(`SPROTE`·`SBLESS`·`SRFIRE`·`SRCOLD`·`SRMAGI`·`SBRWAT`·`SSSHLD`·`SKNOWA`·`SDINVI`·`SDMAGI`·`SFLYSP`) 밖의 spellNo는 throw한다. `computeSpecialBuffDur`은 표준 공식을 벗어나는 3주문을 별도 처리한다: `SINVIS`(`MAX(300,1200+B*600)`+MAGE 클래스보너스+rpmext 600, A6 §11-b MAX(300) 하한 복원)·`SLEVIT`(`MAX(300,2400+B*600)`+rpmext 800, 클래스보너스 없음)·`SLIGHT`(`300 + trunc((level+3)/4)*300 + (rpmext?600:0)`, A6 §11-a 연산자 우선순위 버그를 의도된 스케일 공식으로 복원, gated 무시).

`computeDebuffDur(spellNo, input, rng)`은 `DEBUFF_DUR_META`에 등록된 fear/silence/charm 3주문만 처리한다: `dur = constant + (rollDie>0 ? rng(1,rollDie)*rollMult : 0) + intBonus*intMult`, 이어 `targetHasPrmagi`면 `trunc(dur/2)`(무효화 아닌 절반 단축). fear `600 + rng(1,30)*10 + B*150`, silence `3600` 고정(굴림 없음), charm `300 + rng(1,30)*10 + B*30`. 미등록 주문(befuddle·blind·drain_exp)은 throw한다 — 이들은 `debuffEffects.ts`가 별도 모델로 처리한다.

`SpellDispatch.register`/`resolve`(`dispatch.ts`)는 이제 family-agnostic이다 — 카탈로그 밖 주문번호만 `register`에서 throw하고, offensive·비-offensive를 가리지 않고 등록·해소한다. 각 effect 모듈(`buffEffects`·`debuffEffects`·`instantEffects`)은 핸들러 타입이 서로 달라 각자 독립 `SpellDispatch<H>` 인스턴스를 소유한다.

### G5 — 저항 버프

`resistBuff` family 정확히 4주문 {`SRFIRE`·`SRMAGI`·`SRCOLD`·`SSSHLD`}(`buffEffects.ts`)이 각각 대응 P-flag(`PRFIRE`·`PRMAGI`·`PRCOLD`·`PSSHLD`)를 갖는다. `standardBuff`가 `computeBuffDur`로 산출한 `until`을 대상 `Character.buffs`에 기록하고(`grantBuff`), `projectResistFlags(character, now)`가 활성(만료 안 된) 저항 버프만 fresh hex에 `F_SET`으로 투영한다 — `combat/statusEffects.projectStatusFlags`와 동일한 투영 계약이다. `SBRWAT`(수생술)은 catalog `family='buff'`라 G7로 귀속된다(family 필드 tie-breaker). `#84` 저항 감산(creature-only MRMAGI 판독)이 플레이어 수혜자의 저항-read를 소비하는 배선은 아직 없다.

### G6 — 디버프

`debuff` family 정확히 6주문 {`SFEARS`·`SSILNC`·`SCHARM`·`SBEFUD`·`SBLIND`·`SDREXP`}(`debuffEffects.ts`)를 대상(적 `Combatant`)에 순수-report `DebuffOutcome`으로 반환한다(실 write는 #99 라이브 조립 소관 — offensiveSpell의 realmGrowth 보고 선례). fear/silence/charm은 `computeDebuffDur`(G4)로 dur을 산출한다.

- **fear**: dur 굴림 후 대상 `MPERMT`면 완전 면역(`applied:false`) — dur 굴림 자체는 면역 판정 前에 소비된다(roll-then-guard, 오라클 소비 수 일치).
- **charm**: dur 굴림 후 `caster.level < target.level`(엄격 `<`) 또는 `MNOCHA`면 완전 반탄(`applied:false`).
- **silence**: dur 3600 고정.
- **befuddle**: `computeDebuffDur` 미등록이라 별도 모델 — `dur = intBonus + dice(2,6,0)`, 대상 `MRMAGI||MRBEFD`면 `dur=3`(단축), 아니면 `max(5,dur)`.
- **blind**: `MBLIND` 플래그만 부여하고 타이머를 걸지 않는다 — 개안술(`rm_blind`, G7 cure)로 명시 해제하기 전까지 영구 실명이다(원본 `magic8.c`가 dur 변수를 선언만 하고 미사용하는 동작을 그대로 재현).
- **drain_exp**: 즉발(타이머·플래그 없음) — `expLoss = min(dice(L4,L4,1)*30, target.experience??0)`, `L4=trunc((level+3)/4)`.

`curse`(SCURSE=56)는 `SPELL_CATALOG`에 등록돼 있지 않아(spllist가 SCHARM=55에서 끝남) 이 계층에서 제외한다.

### G7 — 비-offensive 즉발/버프

**타이머 보유 10주문**(`buffEffects.ts` `TIMED_BUFF_META`) — 표준 7 {`SBLESS`·`SPROTE`·`SBRWAT`·`SDINVI`·`SDMAGI`·`SKNOWA`·`SFLYSP`}는 `standardBuff`(`computeBuffDur`), 예외 3 {`SINVIS`·`SLEVIT`·`SLIGHT`}는 `specialBuff`(`computeSpecialBuffDur`)로 처리한다. 각각 대응 P-flag(`PBLESS`·`PPROTE`·`PBRWAT`·`PDINVI`·`PDMAGI`·`PKNOWA`·`PFLYSP`·`PINVIS`·`PLEVIT`·`PLIGHT`)를 `projectBuffFlags`가 투영한다.

**즉발 16주문**(`instantEffects.ts`)은 핸들러 타입에 따라 두 dispatch로 나뉜다.

- **report 13주문**(회복 5 + seam 8, `InstantOutcome` 반환): 회복 — `SVIGOR`(vigor, CLERIC/PALADIN 클래스 보너스+RPMEXT), `SMENDW`(mend, CLERIC≥INVINCIBLE/PALADIN 보너스+RPMEXT), `SFHEAL`(완치, `toFull:true`), `SRESTO`(restore, `dice(2,10,0)`+`rng(1,100)<60`이면 마나 완전회복), `SRVIGO`(room_vigor, `rng(1,6)+pietyBonus`+RPMEXT AOE 보고). seam — `STELEP`(teleport)·`SRECAL`(recall)·`SSUMMO`(summon)·`SENCHA`(enchant)·`STRANO`(object_send)·`STRACK`(track)·`SLOCAT`(locate_player)·`SREMOV`(remove_curse) — room/item/world write가 필요해 `{ kind:'seam', effect }` 라벨만 보고하고 실 write는 유예한다.
- **cure 3주문**(`Character`→`Character`): `SCUREP`→`clearPoison`, `SRMDIS`→`clearDisease`, `SRMBLD`→`clearBlind`(`combat/statusEffects.ts`) — `statusEffects` 필드를 해제한다. `rm_blindness`는 카탈로그에 별도 등록되지 않아 `SRMBLD`(rm_blind)로 통합됐다.

회복량 산술은 마나를 소비하지 않는다(마나값은 시전 게이트 `gate.ts` S4가 소비). 마나 완전회복(`SRESTO`)은 별개 effect 보고(`restoredMana`)다.

### G8 — 몬스터 self-target 치유

`crtSpell.ts`의 `isSelfTargetSpell(spellNo)`는 {`SVIGOR`·`SMENDW`·`SFHEAL`}에만 true를 반환한다. `selectSpell`이 이 3종 중 하나를 pick하고 `ospellOf(spellNo)===undefined`(비-offensive)이면 `castSelfHeal(creature, spellNo, ctx)`가 호출된다 — G7 `instantDispatch`(report 핸들러)를 `gated=false`로 재사용해 회복 outcome을 산출하고, `applySelfHeal`이 시전자 `creature.hpcur`에 in-place 적용(`toFull`이면 `hpmax`로 완치, 아니면 `min(hpmax, hpcur+healed)`)한 뒤 `'cast'`를 반환한다(이번 라운드 근접 대체). 그 외 비-offensive 주문 pick은 여전히 `'none'`(근접 진행)으로 접힌다.

이 경로는 오라클 self-heal의 두 부수효과를 의도적으로 유예한다: **마나 소비**는 카탈로그에 치유 주문의 마나 정본이 없어(`OSPELL_GRID`는 공격 격자 전용) 날조 없이 이식 불가하므로 라이브 게이트 배선(#106)에 유예하고, **healer-class 게이트**(오라클은 `class!=CLERIC && !=PALADIN && <INVINCIBLE`이면 self-heal을 막음)는 상수·판정 로직 모두 존재해 이식 가능하나 G8 완료 기준(치유 pick 시 무조건 `'cast'`)이 범위를 좁혀 별도 토픽(#108)에 유예한다.

## 36주문 커버리지

`SPELL_CATALOG.family` 필드가 귀속 정본이다. 비-offensive 총계 = 활성 56 − offensive 20 = **36**, 4개 그룹이 중복·누락 없이 합한다.

| 그룹 | family | 주문 (spellNo 상수) | 수 |
|---|---|---|---|
| G5 저항 버프 | `resistBuff` | SRFIRE·SRMAGI·SRCOLD·SSSHLD | 4 |
| G6 디버프 | `debuff` | SBEFUD·SDREXP·SFEARS·SBLIND·SSILNC·SCHARM | 6 |
| G7 타이머 버프/감지/비행/발광 | `buff`+`detect`+`movement`+`utility` (타이머 보유) | SBLESS·SPROTE·SBRWAT·SDINVI·SDMAGI·SKNOWA·SFLYSP·SINVIS·SLEVIT·SLIGHT | 10 |
| G7 즉발 | `healing`+`cure`+`movement`+`utility`+`detect` (타이머 없음) | SVIGOR·SMENDW·SFHEAL·SRESTO·SRVIGO·SCUREP·SRMDIS·SRMBLD·STELEP·SRECAL·SSUMMO·SENCHA·STRANO·STRACK·SLOCAT·SREMOV | 16 |

합계 4+6+10+16 = **36**.

**family tie-breaker**(귀속이 직관적 분류와 어긋나는 경우, `family` 필드가 우선):

| 주문 | catalog family | 귀속 | 사유 |
|---|---|---|---|
| SBRWAT(수생술) | `buff` | G7 타이머 | resistBuff 4종에 포함되지 않음(family가 `resistBuff`가 아님) |
| SLIGHT(발광) | `utility` | G7 타이머 | `utility`지만 `LT_LIGHT` 타이머를 보유해 타이머 그룹에 안착 |
| SCURSE(curse, 56) | — | 제외 | `SPELL_CATALOG`에 미등록(spllist가 SCHARM=55에서 끝남) — handler 없음 |

## 제약사항 / 범위 밖

이 계층은 **순수 로직 + seam**만 이식한다. 다음은 명시적으로 후속 토픽 소관이다.

- **라이브 command 라우팅** — `study`는 **배선 완료**다(#120, `progress:study`). `cast`(#122)·`teach`(#119)·`read`/`drink`/`zap`(#86)은 여전히 #106 체인 소관이다.
- **production boot 배선**(effect·crtSpell을 라이브 tick에 조립) → #99.
- **몬스터 마나 재생**(`mpcur += MAX(1, mpmax/6)`, A6 §9) → #99. 플레이어 마나 재생은 이미 이식됨(#81 `progression.md`).
- **아이템(scroll/potion/wand) delivery** → #86. 이 계층은 `gated=true`(CAST) effect만 다룬다.
- **offensive `spell_fail` 배선**(전사계 fizzle-after-consume) → #100.
- **self-heal 게이트 2종 유예**: 마나 소비(치유 주문 마나 정본이 카탈로그에 없음) → #106. healer-class 게이트(G8 완료 기준의 무조건 시전 계약이 범위를 좁힘) → #108.
- **realm 성장 write 위치** — `realmGrowthAmount`는 순수 성장량 스칼라만 반환한다. `caster.realm[]` in-place write·`markDirty` 배선은 이 계층에서 하지 않는다(#99). full-스냅샷 dirtyTracker의 last-write-wins와 충돌 가능성은 배선 시점(#99)에 조정한다.
- **PvP 마법 사망·숙련 손실**(`realm[n-5] -= profloss/(9-n)`) → 사망 처리 토픽 소관. 이 계층의 realm 성장은 write(+)만 다룬다.
- **PINVIS 해제**(시전 시 caster 은신 해제) → 라이브 caster 상태를 가진 토픽 소관.

## 관련 문서

- **oracle**: `docs/notes/game-analysis-20260625/a6-magic.md`(§5 realm 성장·§6 버프 타이머·§7 디버프·§8 학습전수·§9 마나·§11 형상버그) · `legacy/muhan/src/magic1.c`(study/teach·addrealm)·`magic2~8.c`(개별 effect)
- **의존 스펙**: [magic.md](magic.md)(#84 Caster·dispatch·gate·offensiveSpell·crtSpell — 이 계층이 확장) · [progression.md](progression.md)(#81 exp 파이프·마나 재생·dirtyTracker) · [combat.md](combat.md)(#83 `statusEffects` `until` 관례·DoT) · [persistence.md](persistence.md)(characterSchema 영속·backfill)
- **후속**: #86(아이템 delivery) · #99(production boot 배선·몬스터 마나 재생·realm write 배선) · #100(offensive spell_fail 배선) · #106(라이브 command 라우팅·self-heal 마나 배선) · #108(self-heal healer-class 게이트)
- **이슈**: #85(본 토픽) · 상위 #84(magic-core) · 에픽 #36(E6 규칙 엔진)
