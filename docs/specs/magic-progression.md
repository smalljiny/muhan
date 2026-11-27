# magic-progression — 마법 지속·성장 (spell store·학습·성장·타이머·비-offensive effect)

> #84가 미뤄 둔 마법 계층의 나머지 절반이다(E6b-2, 이슈 #85). 플레이어 spell store, 학습/전수, realm 숙련 성장, 버프/디버프 타이머, 비-offensive effect 36종, 몬스터 self-heal을 다룬다.

## 개요

#84(`docs/specs/magic.md`)는 CAST delivery, 공격 effect 20종, 시전 게이트, 몬스터 시전 확장 지점(seam)을 이식했다. 하지만 플레이어에게 spell store가 없어서 `Caster.realm=[0,0,0,0]`·`knows=false`를 forward-compat stub으로 반환했다. 이 계층은 그 stub을 **실제 플레이어 spell store**(characterSchema v5)로 바꾼다. 또 카탈로그에 메타데이터만 있던 비-offensive 주문 36종에 실제 effect 본체를 채워 마법 계층을 완성한다.

범위는 **순수 로직 + seam**이다. 지식 비트마스크 read/write, realm 성장 산식, 버프/디버프 dur 산식, effect 핸들러는 모두 순수 함수로 이식한다. 라이브 command 라우팅(`cast`/`study`/`teach`), production boot 연결, 아이템 delivery는 후속 토픽(#106·#99·#86)에 넘긴다.

## 구조

| 위치 | 모듈 | 책임 |
|------|------|------|
| `packages/shared/src/schema/character.ts` | (기존 확장) | `spells`·`realm`·`buffs` 필드, `schemaVersion` 5 |
| `packages/shared/src/magic/spellStore.ts` | — | `isKnown`/`setKnown` 비트마스크 헬퍼(S_ISSET/S_SET 대응) |
| `packages/shared/src/magic/buffCatalog.ts` | — | 버프/디버프 dur 공식을 선언한 메타데이터(`BUFF_DUR_META`·`DEBUFF_DUR_META`) |
| `packages/server/src/repo/characterBackfill.ts` | (기존 확장) | `backfillCharacterV5`·`seedSpellStore`·`CURRENT_CHARACTER_SCHEMA_VERSION=5` |
| `packages/server/src/magic/caster.ts` | (기존 확장) | `toCaster(player)`가 실제 store(`state.spells`/`state.realm`)를 반환 |
| `packages/server/src/combat/playerState.ts` | (기존 확장) | `PlayerCombatState`에 `spells`·`realm` 필드를 전달(`toPlayerCombatState`가 `Character`에서 옮겨 담음) |
| `packages/server/src/magic/learning.ts` | — | `study`·`teach` 순수 함수와 `canTeachSpllv` 전수 등급 판정 |
| `packages/server/src/magic/realmGrowth.ts` | — | `realmGrowthAmount`. realm 숙련 성장량을 구하는 순수 산식 |
| `packages/server/src/magic/offensiveSpell.ts` | (기존 확장) | `applySpellDamage`가 realm 성장량을 `SpellDamageOutcome.realmGrowth`로 보고 |
| `packages/server/src/magic/spellDuration.ts` | — | `computeBuffDur`/`computeSpecialBuffDur`/`computeDebuffDur`/`grantBuff`/`isExpired`/`isBuffActive` |
| `packages/server/src/magic/dispatch.ts` | (기존 확장) | `SpellDispatch.register`/`resolve`가 family를 가리지 않음(비-offensive 등록 허용) |
| `packages/server/src/magic/buffEffects.ts` | — | 저항 버프(G5)와 타이머가 있는 버프/감지/비행/발광(G7) effect |
| `packages/server/src/magic/debuffEffects.ts` | — | 디버프 6종(G6). 결과만 보고하는(pure-report) effect |
| `packages/server/src/magic/instantEffects.ts` | — | 즉발 회복/해제/seam(G7) effect |
| `packages/server/src/combat/statusEffects.ts` | (기존 확장) | `clearPoison`/`clearDisease`/`clearBlind`. cure effect가 쓴다. 이후 blind와 대칭으로 `grantSilence`/`grantFear`/`clearSilence`/`clearFear`/`isSilenceActive`/`isFearActive`가 추가됐다(읽기만 연결, 시전 경로는 미연결. [character-flags.md](character-flags.md)) |
| `packages/server/src/magic/crtSpell.ts` | (기존 확장) | `isSelfTargetSpell`·`castSelfHeal`. 몬스터가 자기 자신을 치유(G8) |
| `packages/shared/src/oracle/` | `generators/*Fixture.ts`+`fixtures/*.json` | 골든 fixture. spell store, spllv, addrealm, buff/debuff dur |

## 스키마 (spell store)

`characterSchema`의 `schemaVersion`이 4→5로 오르면서 필드 3종이 생긴다.

- **`spells`**: `z.array(z.int().min(0).max(255)).length(16)`, required. 128비트 지식 비트마스크다(A6 §8 `spells[16]`). 비트 f는 주문번호 f를 배웠는지를 나타낸다.
- **`realm`**: `z.tuple([int,int,int,int])`(각 `min(0)`), required. 흙/바람/불/물 계열의 누적 경험치다(mstruct.h:195).
- **`buffs`**: `z.strictObject(...).partial().optional()`.
  - 키는 `SPELL_CATALOG` 전체(0-55)에서 파생한 문자열 주문번호다.
  - 값은 `{ until: z.int().min(0) }`(strictObject)이며 `interval`은 없다. 버프는 주기 효과가 아니기 때문이다.
  - `statusEffects`와 나란한 별도 필드로 두지만(D2) `until` 관례는 같다.
  - optional이며 backfill이 채우지 않는다.

`backfillCharacterV5`는 v4 이하 문서를 v5로 올릴 때 `spells`를 16바이트 0으로, `realm`을 `[0,0,0,0]`으로 채운다(`seedSpellStore()`). `buffs`는 채우지 않는다(`statusEffects` v4를 채우지 않은 선례). `schemaVersion>=5` 문서는 다시 채우지 않고 그대로 통과한다. `createCharacter` 생성 경로도 같은 `seedSpellStore()`를 써서 버전 간 어긋남을 막는다.

`isKnown(store, spellNo)`/`setKnown(store, spellNo)`(`spellStore.ts`)는 C 매크로 `S_ISSET`/`S_SET`을 그대로 옮긴 것이다. 바이트 오프셋은 `spellNo>>3`, 비트 위치는 `spellNo&7`이다. `setKnown`은 입력을 바꾸지 않고 새 `number[]`를 반환한다. 이제 `toCaster(player)`는 이 헬퍼를 실제 store에 적용해 `knows(spellNo)`를 읽고, `realm`은 `state.realm`을 그대로 반환한다. 더 이상 `[0,0,0,0]`/`false` stub이 아니다. `Caster` 계약의 필드 수(6개)는 그대로다.

## 동작

### G2 — 학습·전수

`study(char, book)`(`learning.ts`)는 비법서(SCROLL) 연마를 다음 게이트 순서로 평가한다.

1. PBLIND(실명)
2. 아이템 타입(SCROLL이 아님)
3. 레벨(`book.ndice > level`)
4. 성향(`OGOODO`이고 `alignment<-100`, 또는 `OEVILO`이고 `alignment>100`)
5. 클래스(`OCLSEL`이 켜져 있고, 해당 클래스 비트가 없고, `class<CARETAKER`)
6. `magicpower` 유효성(카탈로그 밖이면 `no-spell`)

통과하면 `setKnown(char.spells, book.magicpower-1)`을 적용한 새 store를 반환하고, 실패하면 원래 store를 그대로 반환한다.

study의 **성향 게이트는 알려진 차이(known-divergence)로 동작하지 않는다.** `alignment`의 실제 값 범위가 `[0,2]`(생성 인터뷰의 1|2와 backfill 중립 sentinel 0)라 `<-100`·`>100` 두 분기가 모두 거짓이다. 그래서 지금은 어떤 캐릭터도 성향 때문에 연마를 거부당하지 않는다. 오라클 임계값은 **다시 조정하지 않는다**. 그대로 둬야 E6 성향 시스템([#123](https://github.com/smalljiny/muhan/issues/123))이 `-1000..+1000`을 도입할 때 코드를 고치지 않고 동작한다. 같은 이유로 동작하지 않는 게이트가 `combat/aggro.ts`·`combat/attackStats.ts`·`items/flags.ts`에도 있다([character-flags.md](character-flags.md)).

study와 teach가 읽는 PBLIND·PSILNC는 **`characterSchema.statusEffects`에 영속된 값에서 온다.** `composeCharacterFlags`가 세 변환 결과를 OR해, 소비하는 쪽이 `F_ISSET`으로 읽는 16자 hex를 만든다([character-flags.md](character-flags.md)). `study` 연결(#120)이 그 합성값을 게이트에 주입한다(`teach`는 #119 대기).

### `progress:study` 라이브 연결 (#120)

`ws/handlers/study.ts`가 순수 `study()`를 명령 경로에 연결한다. 핸들러는 게임 규칙을 다시 구현하지 않고 **조회, 합성, 메시지 매핑, 마킹**만 한다.

1. 행위자의 라이브 엔트리를 레지스트리에서 꺼낸다. 대상 범위는 행위자의 소지품으로 한정된다. 아이템 id를 와이어로 받지 않으므로 다른 캐릭터의 아이템에 접근할 경로가 없다.
2. `resolveCarriedObject`로 `target`·`ordinal`을 인벤토리 범위에서 해석한다([`items-equipment.md`](items-equipment.md)). 관찰자 flags는 `composeCharacterFlags(character, now)`로 합성해 넘긴다.
3. 해석된 쌍의 템플릿을 `study()`에 넘겨 게이트를 평가한다. 실패 갈래는 `Record<Failure, string>`으로 한국어 거부 메시지에 매핑해 `error{rule_rejected}`로 답한다.
4. 성공하면 라이브 엔트리를 `{ ...live, character }`로 바꾼다. 그다음 `markCharacterDirty` → `markObjectDeleted` 순서로 두 write를 마킹하고(순서 계약은 [`save-policy.md`](save-policy.md)), `progress:studied`를 본인에게 1회 보낸다.

성향 게이트가 동작하지 않으므로(위 divergence) 지금 라이브 경로에서 성향 때문에 연마가 거부되는 일은 없다.

`teach(caster, target, spellNo)`는 다음 순서로 평가한다.

1. PBLIND
2. PSILNC
3. base-class(`CARETAKER`/`MAGE`/`CLERIC`만 통과, `INVINCIBLE`·`SUB_DM`·`DM`은 불가)
4. 주문 존재(`spellByNo`)
5. 시전자 지식(`isKnown`)
6. `spllv` 전수 등급

`canTeachSpllv(casterClass, spllv)`는 등급별 최소 클래스를 판정한다: spllv 1(`CLERIC`↑)·2(`MAGE`↑)·3(`INVINCIBLE`↑)·4(`CARETAKER`↑)·5(`SUB_DM`↑). 그런데 base-class 게이트가 `INVINCIBLE`·`SUB_DM`을 막으므로 spllv 5 주문은 사실상 전수할 수 없다. 이 quirk는 원작 그대로 남겨 둔다. 통과하면 `setKnown(target.spells, spellNo)`을 적용한 새 store를 반환한다.

두 함수 모두 순수 함수다. 비법서 소멸, 낙하, 전수 broadcast 같은 부수효과는 라이브 라우팅(#106)이 담당한다.

### G3 — realm 숙련 성장

`realmGrowthAmount(m, exp, hpmax) = min(trunc(m*exp/max(1,hpmax)), exp)`(`realmGrowth.ts`, magic1.c:1122-1130)는 combat `deathDistribution`의 기여자 exp 공식과 형태가 같다. `offensiveSpell.applySpellDamage`(5단계)는 대상이 creature일 때만(`target.kind==='creature'`, PvE 가드) 이 함수를 호출한다. 인자는 오버킬 캡 `m`, 대상 `experience`, `hpmax`이며, 결과 성장량은 `SpellDamageOutcome.realmGrowth`로 보고한다. `caster.realm[]`에 실제로 쓰지는 않는다. 성장량 스칼라만 반환하고, 실제 write는 라이브 조립(#99)이 `markDirty` seam으로 처리한다. 자기 자신이나 PLAYER(PvP)가 대상이면 이 블록에 도달하지 않으므로 성장은 0이다.

### G4 — 지속효과 타이머

버프/디버프 만료는 `statusEffects.until`과 같은 **절대 틱** 관례를 따른다. `isExpired(until, tick) = tick > until`(`spellDuration.ts`)은 `statusEffects.isActive(until>=now)`의 부정이다. 경계인 `tick===until`은 아직 활성이다. `grantBuff(character, spellNo, until)`은 `character.buffs`에 `{ [spellNo]: { until } }`을 병합한 새 `Character`를 반환한다(다시 grant하면 덮어쓴다). `isBuffActive(character, spellNo, tick)`는 `combat/statusEffects.isActive`에 그대로 위임한다.

`computeBuffDur(spellNo, input)`은 A6 §6 표준 공식 `MAX(300, 1200 + intBonus*600)`에 두 보너스를 더한다.
- 클래스 보너스: `classBonusClasses`면 `+60*trunc((level+3)/4)`.
- RPMEXT 방 보너스: `+rpmext`(표준 800, detect·fly는 600).

`gated=false`(CAST가 아님)면 고정값 1200(`NON_CAST_BUFF_DUR`)을 반환한다. `BUFF_DUR_META`에 등록된 표준 11주문(`SPROTE`·`SBLESS`·`SRFIRE`·`SRCOLD`·`SRMAGI`·`SBRWAT`·`SSSHLD`·`SKNOWA`·`SDINVI`·`SDMAGI`·`SFLYSP`) 밖의 spellNo는 throw한다.

`computeSpecialBuffDur`은 표준 공식에서 벗어나는 3주문을 따로 처리한다.
- `SINVIS`: `MAX(300,1200+B*600)` + MAGE 클래스 보너스 + rpmext 600. A6 §11-b의 MAX(300) 하한을 복원했다.
- `SLEVIT`: `MAX(300,2400+B*600)` + rpmext 800. 클래스 보너스는 없다.
- `SLIGHT`: `300 + trunc((level+3)/4)*300 + (rpmext?600:0)`. A6 §11-a의 연산자 우선순위 버그를 원래 의도한 스케일 공식으로 복원했고, gated는 무시한다.

`computeDebuffDur(spellNo, input, rng)`은 `DEBUFF_DUR_META`에 등록된 fear/silence/charm 3주문만 처리한다. 공식은 `dur = constant + (rollDie>0 ? rng(1,rollDie)*rollMult : 0) + intBonus*intMult`이고, 이어서 `targetHasPrmagi`면 `trunc(dur/2)`로 줄인다(무효화가 아니라 절반 단축). 주문별 값은 fear `600 + rng(1,30)*10 + B*150`, silence `3600` 고정(굴림 없음), charm `300 + rng(1,30)*10 + B*30`이다. 등록되지 않은 주문(befuddle, blind, drain_exp)은 throw한다. 이들은 `debuffEffects.ts`가 별도 모델로 처리한다.

이제 `SpellDispatch.register`/`resolve`(`dispatch.ts`)는 family를 가리지 않는다. `register`는 카탈로그 밖 주문번호에만 throw하고, offensive든 비-offensive든 등록하고 해석한다. 각 effect 모듈(`buffEffects`·`debuffEffects`·`instantEffects`)은 핸들러 타입이 서로 달라 각자 독립된 `SpellDispatch<H>` 인스턴스를 갖는다.

### G5 — 저항 버프

`resistBuff` family는 정확히 4주문 {`SRFIRE`·`SRMAGI`·`SRCOLD`·`SSSHLD`}(`buffEffects.ts`)이며, 각각 대응하는 P-flag(`PRFIRE`·`PRMAGI`·`PRCOLD`·`PSSHLD`)가 있다. `standardBuff`는 `computeBuffDur`로 구한 `until`을 대상 `Character.buffs`에 기록한다(`grantBuff`). `projectResistFlags(character, now)`는 활성(만료되지 않은) 저항 버프만 골라 새 hex에 `F_SET`으로 바꿔 넣는다. `combat/statusEffects.projectStatusFlags`와 같은 변환 계약이다. `SBRWAT`(수생술)은 catalog `family='buff'`라 G7에 속한다(family 필드 tie-breaker). `#84`의 저항 감산(creature만 MRMAGI를 읽음)이 플레이어 수혜자의 저항 값을 읽도록 연결한 곳은 아직 없다.

### G6 — 디버프

`debuff` family는 정확히 6주문 {`SFEARS`·`SSILNC`·`SCHARM`·`SBEFUD`·`SBLIND`·`SDREXP`}(`debuffEffects.ts`)이다. 대상(적 `Combatant`)에 대한 결과를 순수 보고용 `DebuffOutcome`으로 반환한다. 실제 write는 #99 라이브 조립이 담당한다(offensiveSpell이 realmGrowth를 보고하는 방식과 같은 선례). fear/silence/charm은 `computeDebuffDur`(G4)로 dur을 구한다.

- **fear**: dur을 굴린 뒤 대상이 `MPERMT`면 완전히 면역이다(`applied:false`). dur 굴림은 면역 판정 前에 소비된다(roll-then-guard, 오라클의 굴림 소비 횟수와 일치).
- **charm**: dur을 굴린 뒤 `caster.level < target.level`(엄격한 `<`)이거나 `MNOCHA`면 완전히 튕겨 낸다(`applied:false`).
- **silence**: dur 3600 고정.
- **befuddle**: `computeDebuffDur`에 등록되지 않아 별도 모델을 쓴다. `dur = intBonus + dice(2,6,0)`이고, 대상이 `MRMAGI||MRBEFD`면 `dur=3`(단축), 아니면 `max(5,dur)`다.
- **blind**: `MBLIND` 플래그만 붙이고 타이머는 걸지 않는다. 개안술(`rm_blind`, G7 cure)로 명시적으로 해제하기 전까지 영구 실명이다. 원본 `magic8.c`가 dur 변수를 선언만 하고 쓰지 않는 동작을 그대로 재현했다.
- **drain_exp**: 즉발(타이머와 플래그 없음). `expLoss = min(dice(L4,L4,1)*30, target.experience??0)`, `L4=trunc((level+3)/4)`.

`curse`(SCURSE=56)는 `SPELL_CATALOG`에 없어서(spllist가 SCHARM=55에서 끝남) 이 계층에서 뺀다.

### G7 — 비-offensive 즉발/버프

**타이머가 있는 10주문**(`buffEffects.ts` `TIMED_BUFF_META`):
- 표준 7 {`SBLESS`·`SPROTE`·`SBRWAT`·`SDINVI`·`SDMAGI`·`SKNOWA`·`SFLYSP`}은 `standardBuff`(`computeBuffDur`)로 처리한다.
- 예외 3 {`SINVIS`·`SLEVIT`·`SLIGHT`}은 `specialBuff`(`computeSpecialBuffDur`)로 처리한다.
- 각 주문의 P-flag(`PBLESS`·`PPROTE`·`PBRWAT`·`PDINVI`·`PDMAGI`·`PKNOWA`·`PFLYSP`·`PINVIS`·`PLEVIT`·`PLIGHT`)는 `projectBuffFlags`가 변환한다.

**즉발 16주문**(`instantEffects.ts`)은 핸들러 타입에 따라 두 dispatch로 나뉜다.

- **report 13주문**(회복 5 + seam 8, `InstantOutcome` 반환):
  - 회복:
    - `SVIGOR`(vigor): CLERIC/PALADIN 클래스 보너스 + RPMEXT.
    - `SMENDW`(mend): CLERIC≥INVINCIBLE/PALADIN 보너스 + RPMEXT.
    - `SFHEAL`(완치): `toFull:true`.
    - `SRESTO`(restore): `dice(2,10,0)`, 그리고 `rng(1,100)<60`이면 마나 완전 회복.
    - `SRVIGO`(room_vigor): `rng(1,6)+pietyBonus` + RPMEXT, AOE로 보고.
  - seam: `STELEP`(teleport)·`SRECAL`(recall)·`SSUMMO`(summon)·`SENCHA`(enchant)·`STRANO`(object_send)·`STRACK`(track)·`SLOCAT`(locate_player)·`SREMOV`(remove_curse). room/item/world write가 필요해서 `{ kind:'seam', effect }` 라벨만 보고하고 실제 write는 미룬다.
- **cure 3주문**(`Character`→`Character`): `SCUREP`→`clearPoison`, `SRMDIS`→`clearDisease`, `SRMBLD`→`clearBlind`(`combat/statusEffects.ts`). `statusEffects` 필드를 해제한다. `rm_blindness`는 카탈로그에 따로 등록되지 않아 `SRMBLD`(rm_blind)로 합쳐졌다.

회복량 계산은 마나를 소비하지 않는다(마나는 시전 게이트 `gate.ts` S4가 소비한다). 마나 완전 회복(`SRESTO`)은 별도 effect(`restoredMana`)로 보고한다.

### G8 — 몬스터 self-target 치유

`crtSpell.ts`의 `isSelfTargetSpell(spellNo)`는 {`SVIGOR`·`SMENDW`·`SFHEAL`}에만 true를 반환한다. `selectSpell`이 이 3종 중 하나를 고르고 `ospellOf(spellNo)===undefined`(비-offensive)이면 `castSelfHeal(creature, spellNo, ctx)`가 호출된다. 처리 순서는 다음과 같다.
1. G7 `instantDispatch`(report 핸들러)를 `gated=false`로 재사용해 회복 outcome을 구한다.
2. `applySelfHeal`이 시전자 `creature.hpcur`에 in-place로 적용한다. `toFull`이면 `hpmax`까지 완치하고, 아니면 `min(hpmax, hpcur+healed)`로 올린다.
3. `'cast'`를 반환한다(이번 라운드 근접을 대신함).

그 밖의 비-offensive 주문을 고르면 여전히 `'none'`(근접 진행)으로 처리된다.

이 경로는 오라클 self-heal의 두 부수효과를 일부러 미룬다.
- **마나 소비**: 카탈로그에 치유 주문의 마나 기준 값이 없어(`OSPELL_GRID`는 공격 격자 전용) 값을 지어내지 않고는 이식할 수 없다. 그래서 라이브 게이트 연결(#106)로 미룬다.
- **healer-class 게이트**: 오라클은 `class!=CLERIC && !=PALADIN && <INVINCIBLE`이면 self-heal을 막는다. 상수와 판정 로직이 모두 있어 이식할 수는 있다. 하지만 G8 완료 기준(치유 주문을 고르면 무조건 `'cast'`)이 범위를 좁혀 두었으므로 별도 토픽(#108)으로 미룬다.

## 36주문 커버리지

귀속 기준은 `SPELL_CATALOG.family` 필드다. 비-offensive 총계는 활성 56 − offensive 20 = **36**이며, 4개 그룹이 중복과 누락 없이 이 수를 채운다.

| 그룹 | family | 주문 (spellNo 상수) | 수 |
|---|---|---|---|
| G5 저항 버프 | `resistBuff` | SRFIRE·SRMAGI·SRCOLD·SSSHLD | 4 |
| G6 디버프 | `debuff` | SBEFUD·SDREXP·SFEARS·SBLIND·SSILNC·SCHARM | 6 |
| G7 타이머 버프/감지/비행/발광 | `buff`+`detect`+`movement`+`utility` (타이머 보유) | SBLESS·SPROTE·SBRWAT·SDINVI·SDMAGI·SKNOWA·SFLYSP·SINVIS·SLEVIT·SLIGHT | 10 |
| G7 즉발 | `healing`+`cure`+`movement`+`utility`+`detect` (타이머 없음) | SVIGOR·SMENDW·SFHEAL·SRESTO·SRVIGO·SCUREP·SRMDIS·SRMBLD·STELEP·SRECAL·SSUMMO·SENCHA·STRANO·STRACK·SLOCAT·SREMOV | 16 |

합계 4+6+10+16 = **36**.

**family tie-breaker**(직관적인 분류와 귀속이 어긋나면 `family` 필드를 따른다):

| 주문 | catalog family | 귀속 | 사유 |
|---|---|---|---|
| SBRWAT(수생술) | `buff` | G7 타이머 | family가 `resistBuff`가 아니라서 resistBuff 4종에 들어가지 않음 |
| SLIGHT(발광) | `utility` | G7 타이머 | `utility`지만 `LT_LIGHT` 타이머가 있어 타이머 그룹에 속함 |
| SCURSE(curse, 56) | — | 제외 | `SPELL_CATALOG`에 없음(spllist가 SCHARM=55에서 끝남). handler 없음 |

## 제약사항 / 범위 밖

이 계층은 **순수 로직 + seam**만 이식한다. 다음은 명시적으로 후속 토픽이 담당한다.

- **라이브 command 라우팅**: `study`는 **연결이 끝났다**(#120, `progress:study`). `cast`(#122), `teach`(#119), `read`/`drink`/`zap`(#86)은 여전히 #106에서 이어지는 토픽들이 담당한다.
- **production boot 연결**(effect와 crtSpell을 라이브 tick에 조립) → #99.
- **몬스터 마나 재생**(`mpcur += MAX(1, mpmax/6)`, A6 §9) → #99. 플레이어 마나 재생은 이미 이식됐다(#81 `progression.md`).
- **아이템(scroll/potion/wand) delivery** → #86. 이 계층은 `gated=true`(CAST) effect만 다룬다.
- **offensive `spell_fail` 연결**(전사계의 fizzle-after-consume) → #100.
- **self-heal 게이트 2종 보류**: 마나 소비(카탈로그에 치유 주문 마나 기준 값이 없음) → #106. healer-class 게이트(G8 완료 기준의 무조건 시전 계약이 범위를 좁힘) → #108.
- **realm 성장 write 위치**: `realmGrowthAmount`는 순수 성장량 스칼라만 반환한다. `caster.realm[]` in-place write와 `markDirty` 연결은 이 계층에서 하지 않는다(#99). full-스냅샷 dirtyTracker의 last-write-wins와 충돌할 수 있는 부분은 연결할 때(#99) 조정한다.
- **PvP 마법 사망과 숙련 손실**(`realm[n-5] -= profloss/(9-n)`) → 사망 처리 토픽이 담당한다. 이 계층의 realm 성장은 증가(+) write만 다룬다.
- **PINVIS 해제**(시전할 때 caster의 은신 해제) → 라이브 caster 상태를 가진 토픽이 담당한다.

## 관련 문서

- **오라클**: `docs/notes/game-analysis-20260625/a6-magic.md`(§5 realm 성장·§6 버프 타이머·§7 디버프·§8 학습전수·§9 마나·§11 구현 버그) · `legacy/muhan/src/magic1.c`(study/teach·addrealm)·`magic2~8.c`(개별 effect)
- **의존 스펙**: [magic.md](magic.md)(#84 Caster·dispatch·gate·offensiveSpell·crtSpell — 이 계층이 확장) · [progression.md](progression.md)(#81 exp 파이프·마나 재생·dirtyTracker) · [combat.md](combat.md)(#83 `statusEffects` `until` 관례·DoT) · [persistence.md](persistence.md)(characterSchema 영속·backfill)
- **후속**: #86(아이템 delivery) · #99(production boot 연결·몬스터 마나 재생·realm write 연결) · #100(offensive spell_fail 연결) · #106(라이브 command 라우팅·self-heal 마나 연결) · #108(self-heal healer-class 게이트)
- **이슈**: #85(본 토픽) · 상위 #84(magic-core) · 에픽 #36(E6 규칙 엔진)
