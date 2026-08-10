# magic — 마법 코어 (카탈로그·시전·공격 데미지)

> 무한의 단일 주문 함수를 effect(순수 효과)와 delivery(진입 경로 어댑터)로 분리하고, 주문 카탈로그를 선언 데이터로 외부화하며, CAST 시전 게이트·공격 주문 20종 데미지·몬스터 시전 seam을 확정하는 마법 계층(E6b-1, 이슈 #84).

## 개요

무한의 마법은 **단일 주문 함수 집합을 네 진입 경로(CAST·SCROLL·POTION·WAND)가 공유**하는 구조다. 원본은 주문 하나가 `int fn(caster, cmnd, how)`이고 `how`만 바꿔 재사용하며, 시전자가 플레이어든 몬스터든 같은 함수를 탄다 — 몬스터 마법조차 `crt_spell`이 크리처를 시전자 자리에 넣어 동일 함수를 CAST 경로로 호출한다. 결정적 비대칭은 **마나·클래스·주문지식 게이트가 전부 `how==CAST` 조건**이라는 점이다. 아이템 경로는 이 게이트를 우회하고 대신 소모·`spell_fail` 굴림으로 게이트된다.

이 계층은 그 구조를 **effect/delivery 분리**(ADR 전역 불변식 3)로 재설계한다. `how==CAST` 4중 조건 분기는 `CastContext.gated` 단일 boolean으로 접히고, 주문 정본(`global.c`의 `spllist`·`ospell` 정적 테이블)은 선언 카탈로그로 외부화된다. 공식·수치·게이트 *의미*는 콘텐츠로 충실히 이식하고, 함수 포인터 테이블·인라인 게이트·선형 탐색은 형상으로 재설계한다.

**#84의 범위**는 마법 시스템의 핵심 절반이다:
- CAST delivery 경로 + 공격 계열 effect 20종 + 시전 게이트 + 몬스터 시전 seam.
- 카탈로그는 **전체 56+20 메타데이터**를 확정하되, 비-offensive 36주문의 effect 본체는 후속(#85)에 유예한다(엔트리는 존재).
- delivery **추상 인터페이스**(`gated` 플래그)는 정의하되 scroll/potion/wand **아이템** 어댑터 본체는 #86 소관이다.

결과는 이미 머지된 전투 코드([combat](combat.md)) 위에서 **cast → 공격 데미지 → 사망**이 end-to-end로 동작하는 독립 배포 단위다.

## 구조

카탈로그(선언 데이터)는 몹·플레이어·향후 클라이언트가 공유하므로 `shared`에, effect·게이트·데미지 산술은 라이브 인스턴스·RNG를 소비하므로 `server`에 둔다. 골든 fixture는 E8 오라클 하네스에 둔다.

| 위치 | 모듈 | 책임 |
|------|------|------|
| `packages/shared/src/magic/` | `catalog.ts` | 주문 카탈로그 선언 테이블 — `SPELL_CATALOG`(56)·`OSPELL_GRID`(20)·`REALM`/`SPELL_NO` 상수·`spellByNo`/`ospellOf` O(1) 조회. read-only 메타데이터 단일 출처. |
| `packages/server/src/magic/` | `caster.ts` | `Caster` 추상(몹·플레이어 공유 6필드) + `toCaster` 오버로드 어댑터. |
| | `castContext.ts` | `CastContext` — `ResolveContext` + `gated` 한 필드. |
| | `dispatch.ts` | `SpellDispatch<H>` — 주문번호 → 핸들러 O(1) 디스패처. 비-offensive는 `NOT_IMPLEMENTED` 마커. |
| | `gate.ts` | 시전 게이트 — `evaluateGate`(순수)·`applyCastGate`(마나 소비). |
| | `spellFail.ts` | 클래스별 `spell_fail` chance 테이블·굴림 + `rollsSpellFail` 호출조건 predicate. |
| | `mprofic.ts` | realm 원시 누적경험치 → 0-110 숙련 백분율(read-only). |
| | `offensiveSpell.ts` | 공격 주문 20종 데미지 effect — bns·방상성·마법저항·death 발화. |
| | `crtSpell.ts` | MMAGIC 몬스터 시전 seam — 주문 선택·게이트·offensive 시전. |
| | `index.ts` | server magic 공개 배럴(카탈로그는 shared 소유라 재노출 안 함). |
| `packages/shared/src/oracle/` | `generators/*Fixture.ts` + `fixtures/*.json` | 골든 fixture 4종 — `mprofic`·`offensive_spell`·`ospell`(격자)·`spell_fail`. |

## 카탈로그 스키마

주문 정본은 두 선언 테이블이다. 오라클 byte 정본은 `global.c:575-659`(spllist·ospell)·`mtype.h:233-289`(주문번호)다.

### `SPELL_CATALOG` — spllist 56 엔트리

`SpellEntry`는 effect 본체 없이 **메타데이터 5필드만** 담는다(함수 참조 유입 차단, #85 유예 경계):

```
SpellEntry { spellNo, koreanName, family, spllv, offensive }
```

- 활성 행은 spellNo 0-55 = **56개**다. 상위 태스크 문구의 "55"는 최대 인덱스(SCHARM=55)를 개수로 오독한 off-by-one이며, byte 정본에 따라 56을 정본으로 삼는다(SCURSE=56은 spllist 미등록).
- `family`는 splfn(C effect 함수 포인터)을 도메인 카테고리로 추상화한 것이다: `healing`·`cure`·`buff`·`resistBuff`·`detect`·`movement`·`debuff`·`utility`·`offensive`(+ union 보존용 `antiUndead`). offensive 20종은 `family='offensive'`·`offensive=true`로 `OSPELL_GRID`에 대응한다.

### `OSPELL_GRID` — ospell 공격주문 20 엔트리

`OspellEntry`는 C `struct osp_t` 필드를 그대로 옮긴다:

```
OspellEntry { spellNo, realm, mp, ndice, sdice, pdice, bonusType }
```

- **realm 1-4 × tier 1-5 격자**로 생성한다. tier별 공통 기본 셀(`TIER_BASE`)에서 벗어나는 4개 셀만 `OSPELL_EXCEPTIONS`로 sdice/pdice를 오버라이드한다(FIRE tier1·FIRE tier2·WATER tier2·EARTH tier4 — 전부 global.c 관찰 근거 주석 명시). 20행을 하드코딩하지 않고 격자 규칙으로 압축한다.
- `REALM` = { EARTH:1, WIND:2, FIRE:3, WATER:4 } — 값은 C `osp_t.realm` 바이트와 일치한다.

### 조회

`spellByNo(n)`·`ospellOf(n)`은 모듈 로드 시 1회 빌드하는 `ReadonlyMap` 기반 O(1) 조회다(cast는 per-round hot path라 선형 탐색 금지). 카탈로그 밖 번호는 `undefined`를 반환한다. 카탈로그의 offensive 집합 === `OSPELL_GRID` 집합이 테스트로 고정돼(`catalog.test.ts`), `ospellOf(n)===undefined`는 `!offensive`와 동치다.

`spellByName(query)`는 한글 주문명 조회이며 `{kind:'found'|'ambiguous'|'notFound'}`를 돌려준다. 매칭 규칙 본체(완전일치 리셋·즉시 종료·접두 누적·모호 거부)는 `naming/matchSpellName`이 단독 소유하고 여기서는 `SPELL_CATALOG`를 바인딩해 **호출만** 한다 — 정본은 [`name-matching.md`](name-matching.md). `SPELL_BY_NO`처럼 완전일치 이름 인덱스를 두고 앞질러 반환하면 오라클 규칙의 절반을 이 모듈에 복제하는 셈이라 두지 않는다. 번호 조회와 달리 이름 조회는 hot path가 아니다(명령 입력 경로, 라운드당 최대 1회)이고 카탈로그는 56행 정적 테이블이다. 순회 순서는 `SPELL_CATALOG` 선언 순서 = 오라클 `spllist` 배열 순서지만, 결과는 순서에 독립이다(모호는 거부, 유일 접두는 순서 무관).

## 동작

### effect/delivery 분리

```
CAST 명령 ─┐
SCROLL ────┤   delivery 어댑터              effect 순수 함수
POTION ────┼─▶ (gated 결정·소모·spell_fail) ─▶ offensiveSpell(caster, target, ctx)
WAND ──────┘    ctx = { gated, room, rng, now, death seam, ledger }
```

- **`CastContext`** = `ResolveContext`(전투 해석 컨텍스트) + `gated` boolean. rng·room·now·death seam·ledger를 전투와 공유해 컨텍스트 표류를 막는다.
- `gated=true`(CAST)면 마나·클래스·knowledge 게이트가 활성화되고, `gated=false`(아이템)면 세 게이트를 전부 우회한다 — 콘텐츠(아이템 효과)를 규칙(시전 자격)으로 막지 않는다는 A6 §1 의미를 보존한다.
- **#84 구현**은 CAST delivery + offensive effect 20 + 몬스터 seam이다. 아이템 delivery 본체는 #86.

### `Caster` 추상

몹(`CreatureInstance`)·플레이어(`PlayerCombatState`)를 시전자로 통일하는 **정확히 6필드** 계약이다(그 이상 노출 금지 — 하위 토픽 #85·#86의 결합 표면을 최소화):

```
Caster { mpCurrent, level, realm[], class, intBonus, knows(spellNo) }
```

- `mpCurrent`만 가변이다. `toCaster`가 get/set을 라이브 소스(`creature.mpcur` / `state.mpCurrent`)에 **write-through 바인딩**해, 게이트의 마나 소비가 실 MP를 감소시킨다(스냅샷이면 소비가 유실). worldGraph 승인 가변 carve-out과 동류다.
- 플레이어는 #84 단독으로는 spell store가 없어 `realm=[0,0,0,0]`·`knows=false` forward-compat seam을 반환했다. **#85(magic-progression)가 이 stub을 실 플레이어 spell store로 대체**해 knowledge 게이트·realm 숙련을 라이브화한다(→ [magic-progression.md](magic-progression.md)). `intBonus`는 `bonusOf(intelligence)` 사전 계산값이다.

### 디스패치

`SpellDispatch<H>`는 주문번호 → 핸들러 O(1) 조회다. 입력 키는 주문번호이며, 한글 주문명 → 번호 해소는 command router 소관(범위 밖)이다. 분기는 카탈로그(`spellByNo(n).offensive`)를 데이터 원천으로 소비한다(하드코딩 20/36 금지):

- **offensive 20** → 등록 가능한 핸들러 슬롯.
- **비-offensive 36** → #84 단계에서는 `NOT_IMPLEMENTED` 심볼 마커였고, **#85(magic-progression)가 실 핸들러로 대체**한다(buff/debuff/instant 디스패치, → [magic-progression.md](magic-progression.md)).
- `register`는 카탈로그 밖 주문을 throw로 거부한다. offensive 디스패처는 offensive 20종만 등록하고, 비-offensive effect 디스패치는 #85가 별도 디스패처로 소유한다.

핸들러 형태 `H`는 제네릭으로 열어 소비자(offensiveSpell·crtSpell)가 결정한다.

### 시전 게이트

`gated` 플래그가 `how==CAST` 4중 조건을 단일화한다. `evaluateGate`는 순수 평가(마나 미소비)로, `gated=false`면 즉시 통과하고 `gated=true`면 **마나 → 클래스 → knowledge** 순으로 첫 실패에서 멈춘다:

1. **마나**: `mpCurrent < manaCost`면 실패(`==`는 통과, `<`만 실패).
2. **클래스**: `requiredClasses`가 있고 그 안에 없으며 `class < INVINCIBLE`이면 실패. INVINCIBLE↑(운영진·초인)는 클래스 게이트를 우회한다. `requiredClasses` 미지정이면 무제한.
3. **knowledge**: 주문 미보유(`knows(spellNo)===false`)면 실패.

`applyCastGate`는 평가를 `evaluateGate`에 위임하고, **gated=true 통과 경로에서만** 마나를 소비한다(`mpCurrent -= manaCost`). 게이트 실패·아이템 경로는 미소비다. 유일한 부수효과는 마나 write-through다.

### `spell_fail` 굴림

magic8.c의 클래스별 시전 실패 굴림을 chance 테이블과 호출조건 predicate **두 개념으로 분리**한다:

- **chance 테이블**(`spellFailChance`): `chance = base*mult + add`, `base = trunc((level+3)/4) + intBonus`(= L4 + bonus[int], C 정수 나눗셈=`Math.trunc`). 8클래스 계수를 `CHANCE_COEFFS` Map에 데이터화한다(MAGE·CLERIC **포함**, 배수는 대부분 5·RANGER만 4·THIEF만 6). 미등록 클래스는 `null`(magic8.c `default: return 0` = 굴림 없이 무조건 성공)을 반환한다.
- **굴림**(`spellFail`): `n = rng(1,100)`을 굴려 `n > chance`면 실패. **chance에 cap 없음** — 고레벨·고지능은 chance>100이 되어 어떤 n에서도 실패하지 않는다(as-shipped 무cap 재현, P1 태그).
- **호출조건**(`rollsSpellFail`): 이 굴림을 실제로 호출하는 건 **전사계 6클래스**(FIGHTER·BARBARIAN·RANGER·PALADIN·ASSASSIN·THIEF)뿐이다. 정규 캐스터(MAGE·CLERIC)는 chance 테이블엔 있어도 개별 주문 fn이 spell_fail을 굴리지 않는다.

이 모듈은 standalone 유닛으로 fixture-lock돼 있으며, #84 offensive 데미지 경로에는 **배선되지 않는다**(아래 제약 참조).

### 숙련 (`mprofic`)

realm별 원시 누적경험치(`realm[]`)를 0-110 숙련 백분율로 환산한다(player.c byte 정본). 클래스마다 12칸 임계 테이블(`prof_array`)이 다르며, `n=realm[index-1]`이 드는 십분위 구간(10*i)에 구간 내 선형 보간(`Math.trunc`)을 더한다. `index`는 realm 번호(1-4)다.

- **read-only** — realm 성장(`addrealm` write)은 #85 소관이라 이 포트는 realm[]을 절대 write하지 않는다. 전 몬스터 realm=0이라 #84 라이브 입력은 항상 prof=0이다.
- **OOB port 결정**: 오라클은 n≥5억이면 미초기화 + 배열 OOB 읽기(C UB)다. realm=0이라 라이브 도달은 불가하나, 정의된 동작으로 **prof=110 clamp**한다.

### 공격 데미지 (`offensiveSpell`)

offensive effect는 **명중 굴림을 하지 않는다**(주문은 auto-hit). 따라서 combat `resolveAttack`의 hit path가 아니라 **데미지 적용·사망 부분만** 재사용한다. 게이트·마나 소비는 시전 진입(`crtSpell`)이 `applyCastGate`로 먼저 처리하고, `offensiveSpell`은 게이트 통과 **이후**의 데미지 산술만 담당한다.

**bns 계산**(`computeBns`, gated 한정): `intBonus + trunc(mprofic(class, realm, osp.realm) / K)` 뒤 방 상성 보정. `K`는 `bonusType`별 나눗수(1→10, 2→6, 3→4). 방 상성은 osp.realm과 방 realm 플래그(RWATER/RFIRER/RWINDR/REARTH)를 대조해 동일 realm이면 강화(`×2`), 상극(물↔불·바람↔땅)이면 약화(`min(-bns, -5)`)한다.

**데미지 적용 순서**(`applySpellDamage`, magic1.c:1096-1170 정본):

1. `dmg = max(1, dice(ndice, sdice, pdice+bns))` — `max(1)`은 저항 前.
2. **마법저항 감산** — creature 대상이 MRMAGI 플래그 보유 시만: `dmg -= trunc(dmg*2*min(50, piety+int)/100)`. `piety+int≥50`이면 완전 무효(dmg 0). 재-clamp 금지(0 데미지 보존). 플레이어 대상은 piety store가 없어 미발동(dead branch 회피).
3. no-op 가드 — `hpBefore < 1`(이미 사망)이면 차감·death·ledger 없이 반환(재진입 death 재발화 방지).
4. 오버킬 캡 `m = min(hpBefore, dmg)`(저항 後·차감 前).
5. ledger 누적 `accumulateDamage(casterId, m)` — creature 대상만.
6. `hp -= dmg`(원본 참조 in-place — 스냅샷이 아니라 `instance.hpcur`/`state.hpCurrent`).
7. `hp < 1`이면 death seam(`fireDeath`) **정확히 1회** — combat 근접과 공유하는 death seam을 재사용해 사망 경로 발산을 막는다.

`registerOffensiveSpells`가 `OSPELL_GRID` 20종을 순회하며 각 spellNo에 osp를 캡처한 핸들러를 디스패처에 등록한다.

### 몬스터 시전 seam (`crtSpell`)

MMAGIC 몬스터의 시전 seam으로, combat `CastSpellSeam` 시그니처 `(caster, target, ctx) => 'cast'|'none'`를 직접 만족해 `createCombatTick`의 `castSpell` 의존에 주입된다. 반환값은 오라클 라운드 재현이다 — `'cast'`=이번 라운드 근접을 주문이 대체(`doMelee=false`), `'none'`=주문 미발동으로 근접 진행.

1. **한 pick**(`selectSpell`): 아는 주문을 비트 순서로 최대 10개 수집해 `rng(1, knowctr)`로 **한 번만** 선택한다(재추첨 금지). 빈 경우 SHURTS(1) 폴백(rng 미호출). spells 비트폭은 128비트(16바이트)다.
2. **offensive 판정**: `ospellOf(spellNo)`가 곧 offensive 게이트다. 비-offensive면 `'none'`으로 접힌다. 단 **self-target 치유 3종(SVIGOR/SMENDW/SFHEAL)은 #85(magic-progression)가 실구현**해 자기 대상(num=2)으로 G7 healing effect를 재사용하고 `'cast'`로 접는다(→ [magic-progression.md](magic-progression.md)). #84 단계에서는 `isSelfTargetSpell` 구조만 forward-compat로 남겼다.
3. **시전 게이트**: `applyCastGate`(mana → class → knowledge). tier5 공격주문 4종(SICEBL·STHUND·SEQUAK·SFLFIL)은 `requiredClasses=[MAGE]`를 실어 비-MAGE·비-INVINCIBLE 몬스터(88종이 오탑재)를 차단한다("도술사만 쓸 수 있는 마법", magic1.c:900). 게이트 실패는 곧 `'none'`(오라클 `return 0`과 동치).
4. **offensive 시전**: 통과 시 디스패처로 핸들러를 해소하고 `gated=true`로 호출한 뒤 `'cast'` 반환.

### combatTick 배선

combat `createCombatTick`의 `castSpell?` 의존에 `crtSpell`을 주입한다. 트리거(`MMAGIC && !MCHARM && rng(1,100) <= 20`)·라운드 순서는 [combat](combat.md)이 소유하며, 이 계층은 seam 반환값(`'cast'`=근접 대체 / `'none'`)만 결정한다. `'cast'`면 그 라운드 근접만 스킵하고 반격은 유지한다.

## 제약사항 / 범위 밖

- **비-offensive effect 본체**(치유·해독·버프·감지·이동·디버프·유틸 36주문) → **#85 완료**([magic-progression.md](magic-progression.md)). #84는 카탈로그 엔트리(메타데이터)만 확정했다.
- **지속효과 타이머**(protection/bless/invisibility/fear/silence/charm dur) → **#85 완료**(절대-틱 `until` polling 모델).
- **realm 숙련 성장 write**(`addrealm`) → **#85 완료**(PvE 한정 순수 함수). #84는 `mprofic` 읽기만.
- **저항 버프 effect**(resist_fire/cold/magic 등 플래그를 *켜는* 주문) → **#85 완료**. #84는 대상 기존 MRMAGI 플래그에 대한 감산만.
- **학습·전수**(study/teach, `spells[16]` 획득·`spllv` 전수등급) → **#85 완료**. #84는 knowledge 게이트 읽기(`S_ISSET`)만.
- **scroll/potion/wand 아이템 delivery** → **#86**. #84는 `gated` 추상 인터페이스만 정의.
- **라이브 플레이어 `cast`/`read`/`drink`/`zap` 명령 라우팅** → 별도 command dispatcher 토픽. #84는 순수 seam만 제공.
- **MMAGIO proficiency 기반 시전 확률** → 미이식.

### 구현 발산 (as-built)

- **spell_fail이 offensive 경로에 미배선(#100 추적)**: 오라클은 `offensive_spell` 안에서 마나 소비 後·데미지 前 `spell_fail`을 굴리지만(magic1.c:1089), 이 포트의 시전 경로(`crtSpell → applyCastGate → offensiveSpell`)는 굴리지 않는다. `spellFail` 모듈은 standalone fixture-lock돼 있다. 실재 12개 전사계 MMAGIC offensive 캐스터의 fizzle-after-consume은 미재현이며, 게이트-타이밍 재설계와 얽힌 비-trivial 작업이라 후속 토픽(#100)에 유예한다.
- **몬스터 시전이 production boot에 미배선(#99 추적)**: `crtSpell`은 `createCombatTick` 주입 테스트로 end-to-end 검증되나, 근접 tick을 포함한 combat tick 전체가 라이브 world runtime boot(`index.ts`)에 아직 composition되지 않았다(Non-goals의 라이브 라우팅 유예). production combat tick 배선(registry/ledger/death/broadcast 포함)은 combat 라이브화 후속 토픽(#99) 소관이다.
- **방 상성 gated 접기**: 오라클은 방 상성 블록을 게이트 밖에 둬 아이템 경로에도 약화(-5)를 적용하나, 이 포트는 상성까지 gated로 접는다. #84엔 아이템 caster가 없어(realm=[0,0,0,0] seam) 그 edge는 관측 불가하며, 아이템-경로 상성은 #86이 실 delivery와 함께 정밀화한다.
- **PINVIS 해제 미이식**: 오라클은 시전 시 caster PINVIS를 해제하나, #84 caster는 몬스터이고 flags가 immutable hex라 cosmetic no-op다(#85 소관).

## 관련 문서

- oracle: `docs/notes/game-analysis-20260625/a6-magic.md`(§1~4·§10), `legacy/muhan/src/magic1.c`(offensive_spell)·`magic8.c`(spell_fail)·`update.c:654`(crt_spell)·`global.c:571-659`(spllist·ospell)
- 의존 스펙: [combat.md](combat.md)(`CastSpellSeam`·death seam·`CreatureInstance` operand) · [stats-core.md](stats-core.md)(파생 스탯·`bonusOf`) · [progression.md](progression.md)(MP 재생 — #84는 소비만) · [golden-fixture-harness.md](golden-fixture-harness.md)(오라클 fixture 규약)
- 이름 조회: [name-matching.md](name-matching.md)(`spellByName` 규칙 본체 — 완전일치 우선·모호 거부)
- 확장 계층: [magic-progression.md](magic-progression.md)(E6b-2 #85 — spell store·학습·성장·타이머·비-offensive effect·몬스터 self-heal)
- 후속: #86(E6d-1 아이템 delivery) · #99(combat production boot 배선) · #100(전사계 spell_fail 배선) · #106(라이브 command 라우팅) · #108(self-heal healer-class 게이트)
