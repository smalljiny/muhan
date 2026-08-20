# 아이템·장비 (items)

> `data/world/objects.json` object 템플릿 인덱스 위에서 착용 게이트(wear/ready/hold)·파생 스탯 투영·rand_enchant·소비 아이템 magic 배달을 순수 함수 + seam으로 재현하는 서버 아이템 계층. `packages/server/src/items/`.

## 개요

무한의 모든 아이템은 `object` 구조체 하나(type 0~14)로 표현되며, 착용은 오라클의 `ready[20]` 슬롯 배열에 포인터를 꽂고 다층 게이트(직업·성별·정렬·크기·레벨)를 통과하는 방식이다. 이 계층은 그 규칙(무엇을)을 오라클(`command3.c`·`object.c`·`magic1.c`·`mtype.h`) 충실로 이식하되, 형상(어떻게)은 순수 함수 + seam으로 재설계한다.

계층 경계는 **순수 로직 + 조회 인덱스 + seam**이다. object 물질화·인벤토리 로딩·룸 배치·WS 명령 파싱·DB write-back·실 인벤 이동/객체 파괴는 배선 유예(§제약사항)로 두고, 이 계층은 입력을 받아 새 값(불변)이나 판별 outcome을 반환하는 순수 함수만 제공한다. characterSchema·objectSchema는 무변경이며 schemaVersion bump가 없다.

## 구조 / 스키마

### 모듈 (`packages/server/src/items/`)

| 모듈 | 책임 |
|------|------|
| `taxonomy.ts` | object 타입 상수 0~14·`isWeapon(type)`·wearflag 슬롯 상수(BODY=1…WIELD=20, MAXWEAR=20)·**`WIELD_SLOT`(=WIELD−1, 0-based 19)**·`routeWearCommand`·`resolveSlot` |
| `flags.ts` | object 플래그 비트 상수·게이트 predicate(성별·정렬·직업·크기·저주·결혼·귀속·enchant) + 종족/성별 상수 |
| `objectTemplate.ts` | `buildObjectTemplateIndex(raw)` → `ReadonlyMap<objnum, ObjectTemplate>`·`loadObjectTemplates(worldRoot?)` 부팅 seam |
| `objectPairing.ts` | `pairObject`·`pairObjects` — 인스턴스↔템플릿 결합(`EquippedPair` 생성의 단일 출처) |
| `carriedTargetResolver.ts` | `resolveCarriedObject` — 소지품 스코프 이름·서수 대상 해소(오라클 `find_obj` 2단 스캔) |
| `equipStats.ts` | `projectEquipStats` — 착용 객체 → `EffectiveStatContext` 기여 필드 compute-on-read 투영. **`findWieldedPair`** — 착용 WIELD 무기 선택의 단일 출처 |
| `wear.ts` | `wearGate`(방어구)·`readyGate`(무기 장착)·`holdGate`(쥠) 다층 게이트 순수 함수 |
| `enchant.ts` | `randEnchant(rng)` 확률 순수 함수(rng 주입) |
| `consume.ts` | `deliverConsumable` — POTION/SCROLL/WAND magic 배달 분류 seam |
| `index.ts` | 공개 배럴 |

### ObjectTemplate (런타임 타입)

`ObjectTemplate`은 objectSchema(인스턴스 문서)와 별개인 런타임 조회 타입이다. `objnum`(=raw `id`)·`name`·`keys`·`type`·`value`·`weight`·`adjustment`·`shotsmax`·`ndice`·`sdice`·`pdice`·`armor`·`wearflag`·`magicpower`·`magicrealm`·`special`·`questnum`·`flags`를 담는다. `keys`는 별칭 배열(예 `["단도","도","단"]`)로, 오라클 `EQUAL`(`mtype.h:579`)이 `name` + `key[0..2]` 4필드를 검사하므로 이름 해소자가 성립하려면 인덱스가 별칭을 실어야 한다. 런타임 가변값 `shotscur`와 표시용 `description`은 제외한다. `world/spawn.ts`의 `SpawnTemplateIndex` 관례(필요 필드만 복사해 raw 번들과 분리, `ReadonlyMap` 반환, `loadWorldFile` seam)를 미러링한다.

`buildObjectTemplateIndex`는 `type > 14`(게시판 엔트리 type 100~120, 18개)를 인덱스에서 제외한다. `data/world/objects.json` 709 엔트리 → 정본 691 엔트리. `flags`는 hex 문자열 비트필드(예 `"0800000000000000"`)로 그대로 보존한다.

### 착용 슬롯 인덱싱

`object.slot`은 0-based(`wearflag − 1`, 0~19)로 objectSchema의 기존 `slot`(nullable int)·`equipped`(boolean) 필드에 저장한다. 오라클의 `ready[20]` 포인터 배열·OWEARS/OWHELD 착용 플래그는 `equipped:true` + `slot`으로 **대체**하며, 별도 flag 영속 필드를 두지 않는다.

다중 슬롯 부위는 `resolveSlot(wearflag, occupied)`이 first-free 0-based 인덱스(만석이면 null)를 반환한다: NECK(wearflag 4)는 슬롯 3·4(2칸), FINGER(wearflag 9)는 슬롯 8~15(8칸), 그 외 단일 부위는 슬롯 `wearflag − 1` 하나. 오라클 `command3.c` `switch(wearflag)` 구조를 그대로 이식한다.

## 동작

### 플래그 게이트 predicate (`flags.ts`)

flags(hex string) 위에서 `world/hexFlags.js`의 `F_ISSET`으로 비트를 판정하는 순수 predicate substrate다. 게이트 순서·ARMOR type 검사·INVINCIBLE 전역 우회 조립은 소비자(`wear.ts`) 소관이며, 이 모듈은 predicate만 제공한다.

- `genderAllowed(flags, gender)` — ONOFEM(여성 거부)·ONOMAL(남성 거부). 오라클 명명 역전 반영(gender 1=남/2=여).
- `alignmentAllowed(flags, alignment)` — OGOODO+정렬<−50 거부, OEVILO+정렬>50 거부. **known-divergence로 미발화** — `alignment` 실 값역이 `[0,2]`(생성 인터뷰 1|2 + backfill 중립 sentinel 0)라 두 조건이 항상 거짓이고 정렬 착용 제한이 걸리지 않는다. 오라클 임계값을 현 값역에 맞춰 "고치면" 오라클 상수가 소실되므로 보존한다 — E6 성향 시스템([#123](https://github.com/smalljiny/muhan/issues/123))이 `-1000..+1000`을 도입하면 코드 변경 없이 발화한다([character-flags.md](character-flags.md)).
- `sizeAllowed(flags, race)` — `i = OSIZE1?2:0 + OSIZE2?1:0`; 1=소형(GNOME/HOBBIT/DWARF)·2=중형(HUMAN/ELF/HALFELF/ORC)·3=대형(HALFGIANT)·0=무제한. INVINCIBLE 우회는 담지 않는다(호출자가 외부 래핑).
- `classAllowed(flags, class)` — ONOMAG+(MAGE|CLERIC) 거부 + OCLSEL 게이트 융합. 게이트 순서상 ONOMAG·OCLSEL이 분리 검사되어야 하므로 착용 게이트는 이 융합 predicate를 쓰지 않고 아래 `oclselBlocks`를 쓴다.
- `oclselBlocks(flags, class)` — OCLSEL 세트 + (OCLSEL+class) 비트 없음 + class<INVINCIBLE이면 거부(true). 세 게이트가 공유해 INVINCIBLE 우회를 단일 출처로 둔다.
- `isCursed`(OCURSE)·`isPersonalBound`(ONEWEV)·`isMarriageGated`(OMARRI)·`needsRandEnchant`(ORENCH) — 단순 비트 조회. OCURSE는 `world/hexFlags.js`에서 재사용한다(중복 정의 없음).

### 착용 게이트 (`wear.ts`)

세 게이트 모두 오라클 순서대로 첫 실패에서 즉시 판별 outcome을 반환하는 순수 함수다. E6 유예 필드(결혼 상태·수치 정렬·무기 숙련·ONEWEV 소유자 일치)는 명시 입력 인자(`WearActor`·`isBoundOwner`)로 받는다. outcome은 `equipped`(slot·equipped 설정된 새 인스턴스, 불변)·`rejected`·`burned`(밸런스 소각)·`bounced`(정렬 반발) 판별 유니온이다.

- **`wearGate`(방어구, `command3.c` wear 52~194)**: 라우팅(WIELD/HELD/미착용 거부) → ①ONOMAG(type===ARMOR) → ②성별(type===ARMOR) → ③shots 소각(`>1001`, questnum==0) → ④레벨/AC(`check_ac`=armor×5·BODY armor×2; `>151 && questnum==0`→burned; `<30`→0; `class<INVINCIBLE && questnum==0 && !ONEWEV && level<check_ac`→rejected) → ⑤결혼(type===ARMOR) → ⑥슬롯 점유 → ⑦파손(shotscur<1) → ⑧정렬→bounced → ⑨OCLSEL → ⑩OSIZE. AC 소각은 `<30→0` 리셋 이전에 검사하며, ONEWEV은 레벨 거부만 면제하고 소각은 면제하지 않는다.
- **`readyGate`(무기 장착 WIELD, `command3.c` ready 691~)**: ①WIELD 아님 거부 → ②마법사 무거운무기 제한(SHARP/THRUST + dice합>14 + questnum==0 + !ONEWEV + MAGE/CLERIC — 플래그 없는 dice 규칙) → ③성별(SHARP/THRUST 조건부) → ④WIELD 슬롯 점유 → ⑤OCLSEL → ⑥정렬→bounced → ⑦OSIZE → ⑧dice 소각(`>39`, questnum==0 && !ONEWEV) → ⑨shots 소각(`>600`, !ONEWEV만 — questnum 무관, ⑧과 비대칭) → ⑩ONSHAT+OALCRT 소각 → ⑪레벨(check_dmg=dice합; FIGHTER−7·ASSASSIN/THIEF−3·PALADIN/RANGER−2; `check_dmg>15 && !ONEWEV && level<check_dmg×3 && questnum==0`) → ⑫ONEWEV 귀속(isBoundOwner 불일치 거부).
- **`holdGate`(쥠 HELD, `command3.c` hold 860~)**: ①HELD/WIELD 아님 거부 → ②이벤트템/임무템(OEVENT‖questnum>0) → ③귀속템/임무템(ONEWEV‖questnum>0) → ④HELD 슬롯 점유 → ⑤강력무기(dice합>100) → ⑥OCLSEL → ⑦정렬→bounced. 통과 시 type 무관하게 equipped=true + HELD 슬롯(16)을 무조건 설정한다(오라클 `type<ARMOR` 분기는 drop된 OWHELD 플래그 전용).

저주(OCURSE)는 세 착용 게이트가 검사하지 않는다 — 오라클에서 저주는 탈착(remove) 시점에 작용한다. `isCursed` predicate는 탈착 enforcement substrate로만 제공되고 그 배선은 유예된다.

### 파생 스탯 투영 (`equipStats.ts`)

`projectEquipStats(equipped, weaponProficiency)`가 착용 (ObjectInstance, ObjectTemplate) 쌍 집합을 `EffectiveStatContext` 기여 부분집합(`equipArmor`·`weaponAdjustment`·`weaponProficiency`)으로 compute-on-read 투영한다. stats-core `computeAc`/`computeThaco`는 재구현하지 않고 이 투영값을 판독한다.

- `instance.equipped === true`인 쌍만 집계한다 — 오라클 `compute_ac`(player.c:980)가 착용 슬롯 배열 `ready[]`만 순회하므로, 호출자가 전 인벤을 넘겨도 미착용 아이템이 AC/THAC0를 오염시키지 않는다.
- `equipArmor` = Σ `template.armor`(부호 유지 — 저주 장비 음수·방패 포함, WIELD 무기 armor도 포함하는 것이 오라클 충실).
- `weaponAdjustment` = `findWieldedPair`가 고른 착용 무기의 `template.adjustment`(슬롯 번호로 판정 — HELD 무기 오인 방지, WIELD 미착용이면 0).

**WIELD 판정을 복제하지 않는다(#121).** 슬롯 좌표 `WIELD_SLOT`은 원산지인 `taxonomy.ts`가 소유하고(wearflag는 1-based, `ObjectInstance.slot`은 0-based라 −1 파생), 선택 자체는 `findWieldedPair(equipped)`가 단독 소유한다. 이유는 명중 보정(`weaponAdjustment`)과 무기 피해 서술자(`combat/assemblePlayerCombatState`의 `WeaponDamage`)가 **서로 다른 모듈에서 만들어지면서 같은 아이템을 설명해야** 하기 때문이다. 각자 판정을 복제하면 그 일치가 두 구현의 우연한 동형성에 기대게 되고, 한쪽에 조건이 하나 붙는 날(부서진 무기 제외 등) 조용히 갈린다 — 두 모듈 각자는 자기 안에서 일관되므로 어느 테스트도 그 갈라짐을 잡지 못한다. 후보가 여럿이면 입력 순서상 첫 매치이며 `pairObjects`가 인벤 순서를 보존한다.
- `weaponProficiency`는 명시 입력 인자를 그대로 투영한다(Character.proficiency[5] 어댑터는 E6 유예).

### rand_enchant (`enchant.ts`)

`randEnchant(rng)`가 rng 주입 순수 함수로 확률표를 재현한다. `rng`는 `(min,max)=>number`(포함 구간) 주입이며 `Math.random`을 직접 호출하지 않는다(shared `makeSeededRng`+`nextIntInRange`로 재현 가능). `draw = rng(1,100)`(포함 구간)에 대해 `draw>98`={99,100}→+3(**2%**)·`draw>90`→+2(8%)·`draw>50`→+1(40%)·`draw≤50`→무변화(50%). `EnchantResult`(`enchanted`·`adjustment`·`pdiceDelta`)만 반환하고 per-instance 적용·`MAX(pdice, adjustment)` 후처리는 배선 유예한다. 오라클 실소스 `object.c:258`가 정본이며, 스펙 초안의 "+3 3%"는 off-by-one 전사 오차(합 101%)로 포팅 원칙에 따라 오라클 실값 2%를 구현한다.

### 소비 아이템 배달 (`consume.ts`)

`deliverConsumable`이 POTION(6)·SCROLL(7)·WAND(8)를 magic dispatch에 배달할 수 있는지 **분류만** 한다. `spellNo = magicpower − 1`이며, `evaluateGate(caster, req, gated=false)`로 시전 자격 게이트(마나·클래스·knowledge)를 우회한다 — 오라클의 마나·knowledge 게이트는 `how==CAST`일 때만 발화하므로 소비 경로(how≠CAST)는 이를 묻지 않는다(`applyCastGate`가 아닌 `evaluateGate`를 써 마나 write-through 없음). 핸들러 형태 H는 dispatch에서 제네릭 미확정이라 실행하지 않고 `dispatch.resolve`로 분류만 한다.

결과는 exhaustive outcome union이다: `noop`(비소비 type)·`depleted`(shotscur<1, 오라클 drink 가드)·`no-spell`(magicpower<1, resolve 이전 특수 처리)·`deferred`(NOT_IMPLEMENTED, 비-offensive #85 유예)·`unresolved`(undefined, offensive 미등록 — 핸들러는 magic S5 등록)·`delivered`(핸들러 resolve 성공). `magicpower<1`을 resolve 이전에 걸러 spellNo=−1이 `unresolved`와 혼동되지 않게 한다.

`shotscur` 감소·객체 파괴는 이 seam이 수행하지 않는다 — 오라클 drink/readscroll/zap은 spell fn 성공(`if(n)`)일 때만 `shotscur--`하는데(magic1.c:647·476·802), 순수 seam은 핸들러를 실행하지 못해 성공을 관찰할 수 없으므로 감소를 결정할 수 없다. charge 감소·파괴는 effect 성공을 관찰하는 배선 계층 소관이며, 이 seam은 입력 인스턴스를 변형하지 않는다.

### 인스턴스↔템플릿 결합 (`objectPairing.ts`)

인스턴스는 **런타임 가변값만**(`shotscur`·`slot`·`equipped`·`owner`) 담고 불변 스탯·이름·별칭은 템플릿이 소유한다. `pairObject`(단수)·`pairObjects`(복수)가 `objnum`으로 둘을 묶어 `EquippedPair`를 만드는 단일 출처이며, **템플릿 값을 인스턴스에 복사하지 않는다** — 복사하면 같은 값의 출처가 둘로 갈리고 템플릿 데이터가 바뀔 때 저장된 인스턴스가 조용히 stale이 된다. 두 함수 모두 입력의 동일 참조를 그대로 실어 새 쌍 객체만 만든다.

미해소 정책이 둘로 갈린다: 단수형은 `undefined`를 돌려 호출자가 의미를 정하고, 복수형은 **조용히 드롭한다**. 따라서 복수형 경로에서 "템플릿 미해소"는 후보 부재와 구분되지 않는다. 착용 여부 필터는 여기서 하지 않는다 — 결합은 착용·미착용을 구분하지 않는 순수 조회이고 필터는 소비자 책임이다.

### 소지품 대상 해소 (`carriedTargetResolver.ts`)

`resolveCarriedObject(inventory, index, target, observerFlags, ordinal?)`가 오라클 `find_obj`의 **2단 스캔**을 이식한다: 1단은 미착용 소지품, 2단은 착용품(`ready[]` 슬롯 순서)이다. 매칭은 `name` + `keys` 별칭 대조([`name-matching.md`](name-matching.md))이고, 가시성 게이트는 관찰자가 `PDINVI`(투명 감지)를 들면 무조건 통과, 아니면 아이템의 `OINVIS`가 없어야 한다.

서수 기준은 오라클과 divergence가 있다(인벤 순서 근거는 [`live-world-foundation.md`](live-world-foundation.md), 추적 [#142](https://github.com/smalljiny/muhan/issues/142)). 오라클 파서가 서수 미지정 시 `val[1]=1`을 넣으므로(`command1.c:505-580`) 와이어 스키마도 `ordinal`을 `min 1`로 강제한다 — `ordinal === 0` 갈래는 라이브 경로에서 도달 불가하지만 오라클 조건(`!obj_ptr || !val`)을 문자 그대로 이식해 단위 테스트가 그 동작을 고정한다.

2단 스캔 자격은 `equipped === true`이면서 `0 <= slot < MAXWEAR`인 것으로 제한한다(오라클 루프가 그 밖의 번호에 도달할 수 없다). `equipped === true`인데 slot이 무효인 인스턴스는 1단에서도 빠져 **이름으로 지목 불가**가 되며, 이 드롭은 현재 무로그다([#143](https://github.com/smalljiny/muhan/issues/143)).

## 제약사항

- **스키마 무변경**: characterSchema·objectSchema 무변경, schemaVersion bump 없음. 슬롯(`slot`)·`equipped`는 objectSchema 기존 필드를 사용하고, 인챈트·소각·착용상태 per-instance 영속 필드는 인스턴스화 토픽 소관이다.
- **배선 유예(Non-goal)** — #120이 일부를 해소했다. **배선됨**: 인벤토리 로딩(세션 진입 시 적재), 템플릿 인덱스 부팅 조립, 소지품 이름 해소, `progress:study`의 객체 파괴(write-behind 삭제). **여전히 유예**: object 물질화·룸 배치, 착용/소비 WS 명령("입다"/"무장"/"마시다"/"벗다") 파싱·라우팅, 착용 outcome(equipped/burned/bounced)의 실 인벤 이동, 소비 shotscur 감소(effect 성공 결합), 탈착(remove) 시점 저주 enforcement, rand_enchant per-instance 적용·저장. 비-삭제 인벤 변경의 write-back 경로는 아직 없다.
- **재구현 금지 경계**: stats-core는 소비만(computeAc/computeThaco 재구현 금지), magic은 seam 호출만(spell effect 본체 재구현 금지 — magic #84 소유), enchant는 rng 주입(Math.random 직접 호출 금지).
- **E6 유예 필드 → 명시 입력**: 결혼 상태·수치 정렬·무기 숙련(proficiency[5])·ONEWEV 소유자 일치는 순수 함수의 명시 입력 인자로 받고, Character→입력 어댑터 배선은 유예한다.
- **경제·은행 범위 밖**: 금화·상점·전당포·수리·소지한도는 [economy.md](economy.md), 은행 물품 보관은 [bank-items.md](bank-items.md)에서 이식(#87). 거래(trade 물물교환)는 유예.

## 관련 문서

- 오라클: `docs/notes/game-analysis-20260625/a8-items-economy.md` §1~6, `legacy/muhan/src/`(`command3.c`·`object.c`·`magic1.c`·`mtype.h`·`player.c`)
- 의존 스펙: `docs/specs/stats-core.md`(EffectiveStatContext 소비) · `docs/specs/magic.md`(caster delivery seam·gate `gated=false`) · `docs/specs/creature-spawn.md`(SpawnTemplateIndex 선례)
