# combat — 근접 전투 해결·특수공격·사망 분배·전투 AI

> 서버 전투 계층이다. 무한에서 4곳에 인라인으로 복제돼 있던 근접 전투를 단일 `resolveAttack` 파이프로
> 통합했다(#82, E6a-1). 여기에 다음을 더했다(#83, E6a-2): 몬스터 특수공격 6종, 상태이상 DoT, 몬스터 사망
> 후처리(exp, 성향, 전리품), 전투 AI의 타깃 선정과 도주, #91 라운드 순서의 충실한 재현.
> **플레이어 오프너(`combat:attack`)는 #121이 라이브 세션에 연결했다.** 몬스터 틱 기반 라운드, 특수공격
> 마커, DoT 조립은 여전히 #99가 담당한다.

## 개요

무한의 근접 전투는 **몬스터 틱 기반 라운드**로 진행된다. 플레이어의 `attack` 명령은 전투를 *개시*하기만
한다(오프너 1타와 적대 등록). 이후 라운드는 다음과 같이 진행된다. 중앙 1Hz 틱이 활성 몬스터를 순회하며,
각 몬스터는 자기 케이던스(민첩 기반 2~3초)마다 공격한다. 그 몬스터의 적 리스트에 오른 플레이어들은 자기
`LT_ATTCK` 쿨다운에 맞춰 자동으로 반격한다. 플레이어에게는 독립된 "초당 공격 스케줄러"가 없다. 플레이어가
주는 피해는 전부 몬스터 틱 안에서 처리되는 반격이다.

원본의 명중·피해 코드는 플레이어 근접(`command5.c attack_crt`)과 몬스터 근접(`update.c update_active`
인라인)에 **4곳에 인라인 복제**돼 있다. 이 계층은 그 복제를 단일 `resolveAttack(attacker, defender, ctx)`
파이프로 통합하고, 스케일 차이는 `attacker.kind`로 분기한다. 스케일 차이란 명중 굴림(`mrand(1,30)` vs
`mrand(1,20)`), 피해식, 크리티컬 유무다. 여기에 몬스터 특수공격(브레스 등 6종), 상태이상 DoT, 사망 시 exp와
성향과 전리품 분배, 전투 AI(선공 타깃 선정, 도주)를 더했다. 그 결과 `resolveAttack`이 감지와 이벤트 발생만
하던 죽음과 타격이 **결과**까지 처리된다.

핵심 분리는 다음과 같다.

- **콘텐츠(충실히 이식)**: 공식, 수치, 라운드 박자, 게이트 의미.
- **구현 방식(재설계)**: 연결 리스트 순회, 인라인 복제, 초 단위 폴링, 데이터 표현(hex flags→명명 필드,
  floor 골드→오브젝트 드롭).

전투가 참조하는 파생 스탯(플레이어 thaco/AC)은 [stats-core](stats-core.md)가 순수 함수로 확정한 값을
**소비만** 한다(재구현 금지). 몬스터 operand, 활성 집합, 틱은 [creature-spawn](creature-spawn.md)이 확정한
런타임을 그대로 쓴다.

**순수 로직·확장 지점(seam) 수준의 경계**: 이 계층은 규칙(확률 게이트, 공식, 순서, 데이터 계약)까지만
구현한다. production boot에서 이 seam들을 조립하는 일은 전부 #99가 담당한다. 조립할 것은 health-pulse xor
접합, 특수공격 status 실적용, exp/성향 실누적, 전리품의 방 floor push, flee/aggro dispatch다. 각 함수는
무엇을 반환하는지로 자기 계약을 표현한다. 호출부가 없는 것은 결함이 아니라 설계다(`creatureDeath.ts`·`progression/death.ts`
선례).

위치는 `packages/server/src/combat/`이다. 라이브 인스턴스(`CreatureInstance`), RNG, stats-core를 소비하므로
server에 두고, 순수 공식 하위 모듈로 나눠 테스트하기 쉽게 한다. flag 상수는
`packages/server/src/world/hexFlags.ts`(hex string, `F_ISSET`)와 `world/roomFlags.ts`(`number[]`,
`hasFlag`)에 기준으로 모은다.

## 모듈 구조

| 모듈 | 책임 |
|------|------|
| `dice.ts` | `dice(n,s,p,rng)=p+Σⁿrng(1,s)`·`mdice(entity,rng)` 프리미티브. `CombatRng` seam(`(min,max)=>number`, mrand 관례)과 `DiceSpec` 타입. `rng`는 필수 파라미터다. 프로덕션 구현 `defaultCombatRng`도 여기 있다(#121. 그전까지 저장소에 실제 굴림 구현이 0건이었다). |
| `constants.ts` | 튜닝 상수. 크리티컬 배수(3~6), 명중 굴림 상한(플레이어 30, 몬스터 20), PvP 쿨다운 증분(+3), MMAGIC 시전 확률(20%), 반격 쿨다운(기본 1초, 실명 6초), 클래스 인덱스. |
| `playerState.ts` | `PlayerCombatState`(라이브 플레이어 전투상태)·`WeaponDamage` 타입과 `toPlayerCombatState` 조립 헬퍼. `flags`는 합성하지 않고 **인자로 받는다**([character-flags.md](character-flags.md)). |
| `combatRegistry.ts` | `CombatRegistry`. characterId를 키로 라이브 전투상태를 담는 인메모리 저장소(register/get/remove/has). |
| `combatant.ts` | `Combatant` discriminated-union 어댑터. 플레이어(`PlayerCombatState`)와 몬스터(`CreatureInstance`)를 같은 전투 operand로 다룬다. `toCombatant` 오버로드. |
| `attackStats.ts` | 명중 임계값, 피해 분기, PALADIN 성향 보정(순수). 플레이어는 stats-core 파생값을 소비하고, 몬스터는 템플릿을 읽는다. |
| `pvp.ts` | 개시 자격 게이트(순수). `checkTargetImmunityPre`(MUNKIL), `checkTargetImmunityPost`(MMGONL/MENONL), `checkPvpGate`(PvP 3중). |
| `enmity.ts` | 적대 등록(`registerEnemy`)과 병렬 데미지 원장(`createDamageLedger`/`accumulateDamage`). |
| `resolveAttack.ts` | 단일 파이프 `resolveAttack(attacker, defender, ctx)`. 명중→피해→특수공격 훅→크리/불발→적용 순서, 다중공격 루프, 내구도를 처리한다. **fire-free**다(died만 반환하고 death seam 실행은 호출자가 담당). |
| `specialAttack.ts` | 몬스터 특수공격 6종(브레스, 에너지드레인, 독, 질병, 실명, 장비용해)의 확률 게이트와 효과를 순수 함수로 이식한 `resolveSpecialAttack`. |
| `statusEffects.ts` | 명명 상태이상(poison/disease/blind/silence/fear)을 부여·해제·읽는 순수 헬퍼. 명명 필드를 combat flag hex 뷰로 바꾸는 `projectStatusFlags`도 있다. silence와 fear는 읽기만 연결됐고 시전 경로는 연결되지 않았다. |
| `dot.ts` | `resolvePlayerDot(char, room, ctx)`. 독/질병/위험방 DoT를 피해만 계산하는 resolver다. `dotApplied`를 반환해 재생과의 xor 계약을 확정한다. |
| `deathDistribution.ts` | `distributeCreatureDeath(dead, room, ledger, deps)`. 데미지 비례 exp 분배, 성향 보정, 전리품/골드 드롭을 순수하게 계산해 반환한다. |
| `aggro.ts` | `selectAggroTarget`/`dexEvades`/`resolveAggro`. 선공 대상을 가중 랜덤으로 고르고 민첩 회피를 판정한다. |
| `flee.ts` | `decideFlee`. PWIMPY/PFEARS 도주를 결정한다(순수, boolean 반환). |
| `combatTick.ts` | `createCombatTick(deps)`. `onCombatTick` 핸들러 팩토리다(몬스터 근접, MMAGIC seam, 적 플레이어 반격, #91 라운드 순서). |
| `initiateAttack.ts` | 플레이어 오프너 `initiateAttack`. 개시 게이트(pre/post 무적 분해), `resolveAttack` 1회, death ripple, 적대 등록을 묶는다. **#121이 `ws/handlers/attack.ts`에서 라이브로 호출한다.** |
| `assemblePlayerCombatState.ts` | `LiveCharacter` → `PlayerCombatState` 조립기(순수, #121). 장비 페어링, `projectEquipStats` 변환, WIELD 무기 해석을 묶어 전투 입력을 만든다. `flags`는 합성하지 않고 주입받는다. 다음 조립으로 넘길 3필드를 만드는 `toCarry`도 함께 export한다. |
| `applyVitals.ts` | 전투상태의 hp·mp를 캐릭터 문서에 병합한다(순수, #121). 하한 0 클램프를 담당한다. `combatant.ts`의 피해 차감에는 클램프가 없어 음수가 될 수 있다. 그런데 `characterSchema`와 와이어 `character:stats`가 둘 다 `min(0)`이라 음수 값은 조용한 flush 실패로 이어진다. 되쓰기 지점이 둘(공격 핸들러, 세션 종료)이라 별도 모듈로 뺐다. |
| `creatureLedgers.ts` | `createCreatureLedgers()`. `Map<instanceId, DamageLedger>` 라우터다(#121). 아래 "ledger per-creature 스코핑" 문제를 해결한다. |
| `index.ts` | 공개 배럴. dice(+`defaultCombatRng`)/constants/playerState/combatRegistry/combatant/attackStats/pvp/enmity/resolveAttack/combatTick/initiateAttack에 #121이 더한 assemblePlayerCombatState·applyVitals·creatureLedgers를 내보낸다. specialAttack·statusEffects·dot·aggro·flee는 여전히 내부에서만 쓴다(#99 대기). |

이 토픽에서 두 모듈에 새 상수를 추가했다.

- `world/hexFlags.ts`(크리처/플레이어/오브젝트 hex flags):
  - 특수공격 관련 M-flag 8개(브레스 3비트 포함): MBRETH/MBRWP1/MBRWP2/MENEDR/MPOISS/MDISEA/MDISIT/MBLNDR
  - PPOISN/PDISEA/PBLIND
  - PWIMPY/PHIDDN/PINVIS/PDMINV
  - MAGGRE/MGAGGR/MEAGGR/MDINVI
- `world/roomFlags.ts`(위험방과 realm의 `number[]` flags): RPHARM/RPPOIS/RPMPDR/RPBEFU, REARTH/RWINDR/RFIRER/RWATER

두 모듈은 서로 다른 엔티티(크리처/플레이어 vs 방)의 flags라 비트 값이 겹쳐도 문제가 없다.

`hexFlags.ts`에는 이후 P-flag 합성을 위해 `PSILNC`(44)·`PFEARS`(43) 상수와 바이트 OR 헬퍼 `orFlags(a, b)`를
추가했다. `orFlags`는 **8바이트를 고정으로 순회**해 입력 길이와 관계없이 항상 16자를 반환한다.
`Math.min(a.length, b.length)`로 순회하면 짧은 피연산자가 결과 폭을 정해 긴 쪽의 상위 바이트가 잘린다.
PBLIND(42), PFEARS(43), PSILNC(44)는 전부 byte 5에 있어 통째로 사라진다. 원작 `mtype.h` 매크로가 아니라
포트에만 있는 헬퍼라 `F_` 접두를 쓰지 않는다(원작은 flags가 고정 8바이트 배열이라 폭 문제가 아예 없다).
자세한 내용은 [character-flags.md](character-flags.md)에 있다.

## 동작

### Combatant 어댑터

`resolveAttack`의 operand는 (플레이어, 몬스터) 또는 (플레이어, 플레이어) 조합이다. `combatant.ts`가 두
소스를 discriminated union으로 통일한다.

- 공통 인터페이스 `CombatantBase`(`hpCurrent`·`armor`·`thaco`·`dexterity`·`flags`)만으로 명중 임계를
  계산할 수 있어 `kind` 비대칭이 드러나지 않는다. `flags`는 양쪽 다 hex string으로 통일해
  `F_ISSET(combatant.flags, bit)` 한 가지 관용으로 읽는다(원작에서도 플레이어는 creature 구조체다).
- 피해 계산에는 kind별 추가 필드(플레이어는 weapon/class/str, 몬스터는 ndice/sdice/pdice)가 필요하다.
  그래서 공통 인터페이스를 키우지 않고 union이 원본 참조(`state`/`instance`)를 담는다.
- `hpCurrent`는 어댑트 시점의 **스냅샷**(읽기 operand)이다. 피해 적용(in-place 차감)은 원본
  참조(`state`/`instance`)를 거쳐 `combatantHp`/`applyCombatantDamage`로 한다.

몬스터 operand에는 전투 스탯(`armor`/`thaco`/`ndice`/`sdice`/`pdice`) 외에 `experience`/`alignment`
선택 필드가 `CreatureInstance` 인스턴스 생성 필드로 추가됐다(사망 분배가 읽는다). embedded 몬스터도
`creatures.json`의 실제 값을 항상 채운다. 그런데도 선택 필드로 둔 것은 여러 테스트의 인라인 리터럴이
컴파일되지 않는 일을 피하기 위해서다. `distributeCreatureDeath`는 이 필드를 `?? 0` 폴백으로 읽는다.

### `resolveAttack` 파이프 — fire-free 단일 타격 → 라운드

`resolveAttack`을 한 번 호출하면 다중공격 count만큼 타격 루프를 돈다. 순수 함수라 전역 상태, `Date.now`,
`Math.random`을 쓰지 않고 모든 랜덤을 `ctx.rng`로만 굴린다. in-place 변형은 defender HP 차감(worldGraph가
승인한 carve-out)과 ledger 누적뿐이며, `AttackOutcome`은 매번 새 객체다.

**진입 가드**: defender HP<1이면 굴림 전에 아무것도 하지 않고 반환한다(`DEAD_DEFENDER_NOOP`). 이 가드는
stale 공격이나 재진입 공격이 사망 뒤에 death seam을 다시 실행하거나 음수 ledger를 쌓는 일을 막는다.

단일 타격 처리(`attacker.kind`로 스케일 분기):

| 단계 | 플레이어 attacker | 몬스터 attacker |
|------|-------------------|-----------------|
| 명중 임계 | `n = thaco − trunc(armor/8)`, PFEARS +2, PBLIND +5 | `n = max(1, thaco − trunc(armor/8))` |
| 명중 굴림 | `rng(1,30) >= n`(`HIT_ROLL_MAX_PLAYER`) | `rng(1,20) >= n`(`HIT_ROLL_MAX_MONSTER`) |
| 특수공격 훅 | 없음 | 명중 직후 `resolveSpecialAttack` 게이트(아래 절) |
| 피해 | 무기: `mdice(무기)+bonus[힘]+trunc(profic/10)` · 바바리안/초인: `mdice(self)+bonus+trunc((level+3)/4)` · MAGE/CLERIC override: 숙련·성장 항을 빼고 다시 굴림 | `special.breathDamage ?? (mdice(self) − trunc((70−armor)/5), <1이면 1, MBEFUD면 trunc(n/3))` |
| 성향 보정 | PALADIN: `alignment<0`→`trunc(n/2)`, `>250`→`n+rng(1,3)` | 없음 |
| 크리티컬/불발 | `rng(1,100) <= mod_profic` 또는 OALCRT면 `n *= rng(3,6)`. 크리티컬이 아니고 무기를 착용했을 때 `rng(1,100) <= (5−mod_profic)`이고 OCURSE가 아니면 `n=0`, 무기 낙하 | 없음 |
| 적용 | 정상타만 `max(1,n)`. 내구도는 `rng(0,3)===0`이면 durabilityHit | breath 발동 시 MBEFUD면 `/3`을 추가 적용(melee path와 별도 분기). 다시 클램프하지 않음 |
| 다중공격 | 초인 전용 `count` 증가 루프(PUPDMG) | 단타 |

- **파생값 기준은 stats-core**: 플레이어 `thaco`/`armor`/`bonus[]`/`mod_profic`은 다시 구현하지 않고
  소비한다.
- **명중 임계 PFEARS +2 / PBLIND +5의 입력이 연결됐다**: `toPlayerCombatState`가 `flags: ''`를
  하드코딩하던 동안에는 두 보정이 구조적으로 동작할 수 없었다. 이제 조립 호출부가
  `composeCharacterFlags(character, now)` 결과를 주입하면 `statusEffects.blind`·`.fear`에서 파생된
  실제 비트를 읽는다([character-flags.md](character-flags.md)). 주입은 연결 토픽(#121)이 담당한다.
- **PALADIN 성향 보정은 known-divergence로 동작하지 않는다**: `alignment`의 실제 값 범위가
  `[0,2]`(생성 인터뷰의 1|2와 backfill 중립 sentinel 0)라 `<0`·`>250` 두 분기가 모두 거짓이고 항상 `n`을
  반환한다. 오라클 임계값은 **다시 조정하지 않는다**. 그대로 둬야 E6 성향 시스템(`-1000..+1000`,
  [#123](https://github.com/smalljiny/muhan/issues/123))을 도입할 때 코드를 고치지 않고 동작한다. 같은
  이유로 동작하지 않는 게이트가 `aggro.ts`(MGAGGR/MEAGGR), `magic/learning.ts`(study OGOODO/OEVILO),
  `items/flags.ts`(`alignmentAllowed`)에도 있다.
- **byte-fidelity**: 모든 `/`는 C 정수 나눗셈이므로 `Math.trunc`로 처리한다.
- **RNG 소비 순서 고정**: 크리 굴림은 OALCRT 자동 크리일 때도 항상 소비한다(`||` 좌변). 불발 굴림은
  크리가 아니고 무기를 착용했을 때만 소비한다. 다중공격 count 굴림은 타격 루프보다 먼저 한다.
- **fire-free(#91, 핵심 변경)**: HP<1을 감지하면 `died=true`를 세우고 break하지만, death seam(`fireDeath`)은
  **더 이상 여기서 실행하지 않는다**. 근접 라운드는 target death를 라운드 끝까지 미뤄 "막타를 치면
  target이 산다"는 동작을 재현해야 하는데, 즉시 실행하면 이것이 불가능하기 때문이다. `fireDeath`/`ResolveContext`(`room`·`now`·
  `fireCreatureDeath`·`firePlayerDeath`·`ledger`) seam 자체는 바꾸지 않는다. magic `offensiveSpell`의
  즉시 실행 경로가 같은 seam을 공유하므로 없애면 magic이 깨진다. 실행 책임은 `combatTick`(근접, 반격)과
  `initiateAttack`(오프너 킬)으로 넘어갔다.
- **ledger 누적**: defender가 몬스터일 때만 `accumulateDamage`를 호출한다. 크레딧은
  `Math.max(0, Math.min(hpBefore, n))`로 오버킬을 자르고 음수를 막는다.

### 몬스터 특수공격 6종

명중 직후, `monsterDamage` **전에** `resolveSpecialAttack(attacker, defender, ctx)`을 굴린다. 오라클(update.c
:387~480)의 게이트 순서를 그대로 지킨다: MBRETH→breath|drain(XOR)→MPOISS→MDISEA→MBLNDR→MDISIT. 각
게이트는 단축평가라서 플래그가 세팅됐을 때만 rng를 소비한다.

| 특수공격 | M-flag | 확률 게이트 | 효과 | 적용 여부 |
|---|---|---|---|---|
| 브레스(4타입) | MBRETH(+MBRWP1/2) | `rng(1,30)<5` | 침(`dice(q,3,0)`), 악취+독(`dice(q,2,1)`), 냉기(`dice(q,4/2,0)`, PRCOLD면 반감), 화염(`dice(q,4/2,0)`, PRFIRE면 반감). `q=trunc((level+3)/4)` | **적용**. breath-replace(`??` lazy)로 normal melee를 대체하고, MBEFUD면 breath에도 `/3` |
| 에너지드레인 | MENEDR | `rng(1,100)<10`(브레스가 발동하지 않았을 때만, XOR) | `dice(q,5,q*5)`로 흡수량을 내고 defender.experience로 상한을 둠 | 흡수량 계산만 함. 실제 exp 차감은 substrate gap(#99, `PlayerCombatState`에 experience 필드 없음) |
| 중독 | MPOISS | `rng(1,100)<=15` | poison 마커 | 마커만. 실제 status 부여는 #99 |
| 질병 | MDISEA | `rng(1,100)<=10` | disease 마커 | 마커만 |
| 실명 | MBLNDR | `rng(1,100)<=10` | blind 마커 | 마커만 |
| 장비용해 | MDISIT | `rng(1,100)<=15` | dissolveItemRolled 마커 | 굴림만, 효과 미적용(Non-goal, #86 substrate 없음) |

브레스만 바로 피해에 반영된다. 나머지 5종은 `SpecialAttackResult` 마커로 `AttackOutcome.specialAttack`에
드러날 뿐 defender를 바꾸지 않는다. `resolveSpecialAttack`은 순수 함수라 throwaway
`{flags, experience: MAX_SAFE_INTEGER}` defender shape로 굴린다. 이렇게 하면 실제 exp 기준 상한이 사실상
걸리지 않는다. 상태 부여, exp 차감, 장비용해 적용은 전부 #99가 이 마커를 읽어 수행한다. 플레이어 attacker
경로는 특수공격을 호출하지 않는다(몬스터 한정).

### 상태이상 데이터 모델·변환

`characterSchema`에 선택 필드 `statusEffects`를 추가했다. 만료 시각은 절대 틱으로 적는다(`befuddledUntil`/`charmedUntil`과
같은 관례). `schemaVersion`은 3→4가 됐고, `backfillCharacterV4`는 버전 스탬프만 찍는다(선택 필드라 다시 채울
필요가 없다).

- `poison`/`disease`: `{ until, interval }`. 주기적으로 피해를 주는 상태이상.
- `blind`: `{ until }`. 명중 페널티만 준다(주기 피해 없음).

`statusEffects.ts`는 다음 헬퍼를 제공한다.

- `grantPoison`/`grantDisease`/`grantBlind`: 입력을 바꾸지 않고 새 Character를 반환한다.
- `isPoisonActive`/`isDiseaseActive`/`isBlindActive`: `until >= now`이면 활성이다.
- 대칭 해제 헬퍼 `clearPoison`/`clearDisease`/`clearBlind`: 입력을 바꾸지 않고 해당 필드를 지운 새
  Character를 반환한다(statusEffects가 없으면 입력을 그대로 반환). 마법 cure 주문(curepoison/rm_disease/rm_blind)이
  이를 쓰며, 원본 F_CLR에 대응한다([magic-progression.md](magic-progression.md) G7 cure).

`projectStatusFlags(character, now)`는 활성 명명 필드를 combat flag hex 뷰(PPOISN/PDISEA/PBLIND)로
바꾼다. 덕분에 combat이 이미 쓰던 `F_ISSET(flags, PBLIND)` 관용을 깨지 않고 유지한다. Character에는 combat
flags 필드가 없으므로 병합하지 않고, ZERO_FLAGS에서 활성 비트만 세팅한 새 hex를 반환한다. 이 변환 함수를
실제로 쓰는 일(라이브 `PlayerCombatState.flags`와 접합)은 #99로 미룬다.

### 플레이어 DoT

`resolvePlayerDot(character, room, ctx)`는 독, 질병, 위험방 DoT의 피해만 계산해
`{ character, died, dotApplied }`를 반환한다(입력 불변, `applyPlayerDeath` 선례).

- **독**(활성 상태이상 또는 harm-room RPPOIS): `hpCurrent -= max(1, rng(1, trunc(hpmax/5)) - bonus[체력])`.
  오라클의 harm-room 변형(`mrand(1,4)`)은 이 공식 하나로 **합쳤다**(의도적 divergence).
- **질병**(활성 상태이상): `hpCurrent -= max(1, rng(1,6) - bonus[체력])`. 공격 쿨다운 증가는
  `PlayerCombatState.nextAttackAt`(combat-state)이 담당해 Character 반환 범위 밖이므로 미룬다.
- **위험방**(`room.flags`, `hasFlag`): RPHARM이 진입 게이트다. 그 안에서 RPMPDR은 mp를 `-= min(mp,3)`만큼 깎는다.
  realm(REARTH/RWINDR/RFIRER/RWATER)이거나 저항 없는 순수 RPHARM이면 `hp -= 8 - min(con,2)` 무형 피해를 준다.
  저항 게이트(PRFIRE/PBRWAT/PSSHLD/PRCOLD)는 `PlayerCombatState` substrate가 없어 걸지 않았다. 그래서
  realm 피해는 항상 저항 없이 발동한다(#99로 미룸). RPBEFU 쿨다운은 combat-state 담당이라 이식하지 않았다.
- **사망 판정**: 클램프 전 raw 값이 `hp<1`이면 `died=true`다. 반환하는 `character.hpCurrent`는 스키마
  `min(0)`에 맞추려고 0으로 클램프한다. 사망 seam 실행은 연결되지 않았다(#99).
- **재생 xor 계약**: `dotApplied`는 이번 틱에 hp/mp 차감이 일어났는지 알린다. DoT와 progression 재생은
  **같은 LT_HEALS 슬롯을 공유하며 서로 배타적**이다. 이 xor 의미론을 반환값으로 확정한다.
  `dotApplied===true`인 틱에는 재생을 건너뛰어야 한다. 실제 펄스 조립(DoT resolver와 재생 provider를 누가
  xor로 접합하는가)은 #99(또는 progression 슬롯 개정)가 담당한다.

### 몬스터 사망 exp 분배·전리품 드롭

`distributeCreatureDeath(dead, room, ledger, deps)`는 순수 함수로 `{ awards, drops }`를 계산해
**반환만** 한다(dead, room, ledger를 바꾸지 않음). `ledger`는 명시적 파라미터로 받으며 `fireCreatureDeath`
시그니처는 바꾸지 않았다. 라이브 조립(사망 seam에서 이 함수를 누가 호출하는가)은 #99가 담당한다.

- **기여자 집합**: `dead.enemies`에 속하고 `ledger.get(id) > 0`인 플레이어다(순서는 `enemies` 배열
  순서). 이 필터로 오라클의 적 리스트 멤버십 게이트를 분배 시점에 재현한다(§오라클과 다른 구현 참조).
- **exp**: `expdiv = trunc(exp * dmg / max(hpmax,1))`. 그룹킬(기여자 2명 이상)이면
  `expdiv + trunc(exp/10)`이고, `min(., exp)`로 상한을 둔다.
- **성향**: 기여자마다 `alignmentDelta = -trunc(alignment/5)`를 준다(delta만 반환하고, 누적과 ±1000 클램프는 #99).
- **전리품**: MTRADE 몬스터는 인벤토리를 떨어뜨리지 않는다(creature.c:311). 그 외에는 `dead.inventory`를 그대로
  drops에 넣는다. **골드는 MTRADE와 관계없이 항상 떨어진다**(creature.c:325, 루프 밖이고 게이트 없음).
  골드는 `ItemInstance(instanceId=\`${dead.instanceId}:gold\`, name=\`${gold}냥\`, value=gold)`로 만든다.
  `RoomNode.items`의 실제 원소 타입이 `ObjectInstance`가 아니라 `ItemInstance`이므로, 이 표현을 쓰면 room
  필드를 새로 만들지 않아도 되고 roomState 스키마도 넓히지 않는다.
- **exp/alignment 소스**: `CreatureInstance.experience`/`alignment` 선택 필드(`?? 0` 폴백). 인스턴스 생성
  시 `creatures.json`(port `readCrt` offset 344/324)의 실제 값을 항상 채운다.

### 전투 AI — 선공 타깃선정·도주

`selectAggroTarget(attacker, players, rng)`은 적이 없는 몬스터가 먼저 공격할 대상을 **가중 랜덤**으로 뽑는다.
(`lowest_piety`라는 이름은 잘못 붙은 것이다. argmin이 아니라 `weight = max(1, C - piety)` 가중 랜덤이다.)

- **MAGGRE**: `C=25`, alignment/레벨 필터 없음.
- **MGAGGR**(선인 공격)/**MEAGGR**(악인 공격): `C=30`. MGAGGR은 `alignment>=100`만, MEAGGR은
  `alignment<=-100`만 대상으로 삼고, 레벨 게이트(`trunc((level+3)/4) >= 공격자 tier`)를 더한다.
- 자격 필터: PHIDDN은 제외한다. PINVIS는 공격자에게 MDINVI가 없으면 제외한다. PDMINV는 무조건 제외한다.
- 자격자가 없으면 `rng`를 굴리지 않고 `null`을 반환한다.

`dexEvades(attacker, target, rng)`는 `target.dexterity > attacker.dexterity && rng(1,10) < 4`(30%
회피)이면 그 라운드를 건너뛴다(민첩이 낮으면 단축평가로 rng를 소비하지 않는다). `resolveAggro`는 타깃 선정과
회피를 오라클 순서대로 묶는다.

`decideFlee(player, rng)`는 PWIMPY(`hpCurrent <= wimpyValue`, 굴림 없음)를 먼저 보고, 아니면
PFEARS(`ff` 공식 굴림)를 보는 else-if 체인으로 도주 여부를 boolean으로 정한다(PFEARS 공식 정정은 §오라클과 다른 구현 참조).

두 모듈 모두 결정 로직까지만 제공한다. 실제 aggro 등록(`registerEnemy`)과 flee 이동 dispatch는 #99로
미룬다. MDINVI 은신 플레이어 탐지는 substrate가 없고, 몬스터 자체 도주(MFLEER)는 오라클에서 dead code라서
둘 다 이식하지 않았다.

### 몬스터 기반 틱(`onCombatTick`) — #91 라운드순서

`createCombatTick(deps)`는 deps를 클로저로 묶어 creature-spawn의 `onCombatTick` 핸들러를 만든다.
`resolveAttack`이 fire-free가 되면서(위 절) 오라클의 근접 라운드 순서를 충실히 재현할 수 있게 됐다.

1. 적이 없으면(`enemies.length===0`) 바로 끝낸다(선공 타깃 선정 dispatch는 #99).
2. **stale-dead 가드**: 몬스터가 이미 HP<1이면 바로 끝낸다. 사망 제거가 커넥션 계층으로 미뤄져 있어 다시
   디스패치될 수 있기 때문이다. 이 가드가 death seam 재실행을 막는다.
3. **present 적 해석**: `enemies` 순서를 지키면서, 방 `occupants`에 있고 레지스트리에 등록된 플레이어만
   모은다. "첫 적"은 `enemies[0]`이 아니라 첫 present 플레이어다. 틱을 시작할 때의 생존 여부를
   `aliveAtStart`로 스냅샷한다. 이것은 counter 자격의 범위를 정한다. 이번 라운드 근접에 죽는 target은
   시작 시점에 살아 있었으므로 자격을 유지하고, stale-dead만 빠진다.
4. **MMAGIC 분기**: `MMAGIC && !MCHARM`이고 `rng(1,100) <= 20`(`MONSTER_SPELL_CAST_CHANCE`)을 통과하면
   `castSpell` seam을 호출한다. 결과가 `'cast'`면 그 라운드의 근접만 건너뛴다(반격은 유지).
5. **몬스터 근접(target melee)**: `doMelee`면 `resolveAttack(creature, target, ctx)`을 부른다. fire-free이므로
   target이 HP<1로 떨어져도 바로 실행하지 않고 `meleeOutcome.died`로 보류해 둔다.
6. **counter 역순**: `[...presentEnemies.slice(1), target]` 순서다. 나머지 적(OTHER enemies)이 먼저, TARGET이 마지막이다.
   `attack_crt`에는 attacker-HP 가드가 없으므로 근접에 죽어가는 target도 마지막에 반격한다.
   `aliveAtStart`가 false인(stale-dead) 플레이어는 반격 자격이 없다. 몬스터가 어떤 counter에 죽으면
   그 자리에서 `fireDeath`를 1회 실행하고 `monsterDied=true`로 break한다. 오라클의 `goto crt_died; if(rtn)
   continue`가 target 사망 체크를 건너뛰는 것과 같아서, **막타를 치면 target이 산다**(보류된 death를
   취소).
7. **라운드 끝 target 사망 판정**: `!monsterDied && meleeOutcome?.died===true`일 때만 `fireDeath`를
   1회 실행한다.

death seam은 근접과 반격 전체를 통틀어 정확히 1회 실행된다. 몬스터는 counter kill 시점에, target은 취소되지
않았을 때만 end-of-round 시점에 실행된다. `onCombatTick`은 몬스터 케이던스(`nextActionAt`)를 절대 읽거나
쓰지 않는다. 재스케줄은 `creatureTick` 슬롯이 담당하고, 플레이어 반격 쿨다운은 `nextAttackAt` 필드로만
관리한다. 실제로 연결할 때는 `creatureTick`과 같은 monotonic tick 소스(`deps.now`)를 읽어야 한다.

### 개시 게이트(`initiateAttack` / pvp)

`initiateAttack(attacker, defender, ctx)`(플레이어 전용 오프너)는 개시 게이트 → `resolveAttack` 1회 →
death ripple → 적대 등록을 차례로 묶은 것이다.

- **대상 무적을 pre/post 2단계로 분해**(#91): 순서는 다음과 같다.
  - `checkTargetImmunityPre`(MUNKIL): `registerEnemy` **전**에 거부하며, aggro조차 등록하지 않는다.
  - `registerEnemy`
  - `checkTargetImmunityPost`: MMGONL이면 무조건 거부한다. MENONL이고 `class < CARETAKER`이면 무기가
    없거나 `adjustment < 1`일 때 거부한다.

  오라클 `add_enm_crt`(:153) 호출이 MUNKIL 거부 뒤, MMGONL/MENONL 거부 앞에 있다. 이 분해는 "MMGONL/MENONL
  몬스터에 실패한 물리 공격도 aggro는 등록된다"는 끼어든 순서를 재현한다. 게이트 하나로 묶어서는 표현할
  수 없던 동작이다. 두 단계를 모두 통과하면 쿨다운 증분은 0이다.
- **PvP 3중**(`checkPvpGate`, 변경 없음): RNOKIL 안전지대면 무조건 거부한다. 양쪽이 PFAMIL이면 주입된
  `checkWarResult`가 게이트 적용 여부를 정한다. 적용되면 `attacker.level < 128`이고 RSUVIV가 아닐 때, 어느
  한쪽이라도 선(PCHAOS 아님)이면 거부한다. 통과하면 쿨다운 증분은 +3이다. 적대 등록은 없다(오라클도
  `add_enm_crt`를 MONSTER 분기에만 둔다).
- **death ripple**(#91): `resolveAttack`이 fire-free이므로, `outcome.died===true`면 `initiateAttack`이
  직접 `fireDeath`를 호출한다. 그러지 않으면 오프너로 죽인 경우 loot, exp, death가 조용히 누락된다.

관용 분리: creature/player flags는 hex string이라 `F_ISSET`로, room flags는 `number[]`라 `hasFlag`로
읽는다. 두 표현을 입력 타입으로 각각 강제하므로 관용을 섞어 쓰면 컴파일러가 막는다. 게이트가 계산한 쿨다운
증분은 `cooldownIncrement`로만 드러내며, 실제 `nextAttackAt` 타이머 세팅은 WS 명령 계층이 담당한다.

### 라이브 플레이어 전투상태

플레이어는 방에서 인스턴스로 생성되는 객체(`CreatureInstance`)가 아니라 세션 액터다. 그래서 방에 붙이지
않고 characterId를 키로 하는 `CombatRegistry`로 관리한다.

- `toPlayerCombatState(character, effectiveContext, weaponDamage)`는 `characterSchema` base와
  stats-core 파생값(`armor=computeAc`, `thaco=computeThaco`)으로 `PlayerCombatState`를 조립한다.
- **가변 carve-out**: 이 객체는 가변이다. 전투 resolver가 `hpCurrent`/`mpCurrent`/`nextAttackAt`을
  in-place로 갱신하고, 레지스트리는 그 참조를 들고 있다.
- `nextAttackAt`은 몬스터의 `nextActionAt`과 다른 별도 필드(플레이어 세션 액터 타이머)다.

**세션 lifecycle 연결은 #121이 채웠다.** `ws/liveWorldWiring.ts`가 진입 코어의 `place`/`release`를 감싸서
월드에 들어올 때 `register`하고 세션이 끝날 때 `remove`한다. `world/`가 `combat/`을 import하지 않는 규약을
지키려고 `liveCharacterEntry`를 고치지 않고 감쌌다. 등록과 제거를 같은 래퍼가 대칭으로 담당하므로 세션 수명
어댑터는 제거를 하지 않는다.

조립 입력은 `assemblePlayerCombatState(live, objectTemplates, flags, carry?)`가 만든다. 다시 조립하는 시점은
**공격할 때마다, 그리고 세션 진입(`place`)** 두 가지다. 진행 중인 전투의 hp, mp, `nextAttackAt`은 `toCarry`로
이어받는다. 이렇게 하면 무효화 규칙 없이도 레벨업과 장비 변경이 다음 공격에 자동으로 반영되고, 진행 중인
전투는 초기화되지 않는다. `place`에도 carry가 필요한 이유는 다음과 같다. 진입 코어가 멱등이라 재접속 시
일찍 반환하는데, 래퍼가 무조건 덮어쓰면 `nextAttackAt`이 0으로 돌아가 재접속으로 쿨다운을 지울 수 있다.

### seam 소비·제공

| 방향 | seam | 계약 |
|------|------|------|
| 소비 | stats-core `computeThaco`/`computeAc`/`bonusOf`/`proficDivisorOf`/`resolveHpMax` + 테이블 | 플레이어 파생 전투 스탯, hp 상한 |
| 소비 | creature-spawn `CreatureInstance`·`nextAction` 케이던스·`activeSet` | 몬스터 operand, 틱 케이던스, 활성 집합 |
| 채움 | creature-spawn `onCombatTick(creature, room)` | 몬스터 라운드 실행 |
| 실행 | creature-spawn `onCreatureDeath`, 플레이어 사망 seam(#81) | HP<1을 감지하면 호출자(`combatTick`/`initiateAttack`)가 실행. 제거와 `distributeCreatureDeath` 접합은 #99 |
| 공유 | `resolveAttack.fireDeath`·`combatant.combatantHp`/`applyCombatantDamage` | [magic](magic.md) offensive 데미지가 재사용(auto-hit이라 hit path를 건너뛰고, 사망은 1회 실행). fire-free로 바꾼 뒤에도 seam 시그니처는 그대로 |
| 제공 | `castSpell` seam([magic](magic.md)이 `crtSpell`로 소비) | 몬스터 시전 게이트 |
| 제공 | `resolveSpecialAttack`·`resolvePlayerDot`·`distributeCreatureDeath`·`selectAggroTarget`/`dexEvades`·`decideFlee` | #99 라이브 조립이 소비할 순수 resolver와 마커 계약 |

## 제약사항 / 범위 밖

**#99(production boot 연결)로 미룬 것**:
- MMAGIC 시전 seam은 채워졌다(magic). 하지만 다음은 이 토픽이 계산까지만 하고 연결하지 않는다: 특수공격
  마커(status 부여, exp 차감, 장비용해), DoT 재생 xor 조립, aggro 실제 등록, flee 실제 이동 dispatch.
- `distributeCreatureDeath`의 **exp 실제 누적은 #121이 연결했다**(`ws/assembleDeathSeams.ts`가 라이브
  레지스트리에 반영). `alignmentDelta`는 아직 적용하지 않는다. 현재 `alignment` 값 범위가 `[0,2]`(#123)라
  델타를 더하면 학습 게이트가 쓰는 1|2 인코딩이 깨진다. ±1000 클램프도 #123을 기다린다. `drops`를
  `room.items`에 push하는 일은 일부러 연결하지 않았다. 방 바닥 아이템을 주울 방법이 없어서(`objectOwnerSchema`에
  room owner 없음) 넣으면 못 줍는 아이템만 쌓인다.
- ~~**ledger per-creature 스코핑(BLOCKING)**~~ — **#121이 해결했다.** `DamageLedger` 타입은 그대로 두고
  연결 코드가 `creatureLedgers.ts`(`Map<instanceId, DamageLedger>`)로 라우팅한다. `distributeCreatureDeath`는
  전달받은 ledger를 "이 죽은 크리처에 한정된 데미지"로 믿는다. 이 전제는 그대로이며, 이제 호출자가 실제로
  지킨다. 타입 자체를 defender-scoped로 바꾸면 `enmity`, `resolveAttack`, `combatTick`까지 영향이 가므로
  여전히 #99가 담당한다.

  남은 갭: `discard`를 부르는 곳이 사망 경로 하나뿐이다. 그래서 공격받다가 **배회로 방을 떠난** 크리처의
  원장은 회수되지 않는다(`instanceId`가 방별 monotonic이라 키를 재사용하지도 않아 Map이 계속 커진다). 사망이
  아닌 소멸을 알리는 seam이 없어 지금은 해결할 수 없고, **#147**이 담당한다.
- 건강 펄스(health-pulse) xor를 어디서 조립할지(`resolvePlayerDot`과 progression 재생 provider를 누가
  접합하는가)는 #99 또는 progression 슬롯 개정이 정한다.

**Non-goal(다른 토픽 담당)**:
- 장비 용해(MDISIT)와 명중 후 방어구 마모 → #86(착용 슬롯·내구도 substrate 없음).
- exp드레인의 `lower_prof`(숙련 하향) → proficiency[5] 배열(E6).
- MDINVI 은신 플레이어 탐지 → 은신 플래그 substrate를 다루는 토픽(현재 없음).
- spell_fail gate-timing 재작업 → #100.
- 플레이어 사망 페널티(exp 손실, 부활, 레벨 하락) → progression(#81) `applyPlayerDeath` 담당. 이 토픽은
  몬스터 사망 분배만 다룬다.
- 몬스터 자체 도주(MFLEER)는 오라클에서 dead code라 이식하지 않았다.
- 영속 write-back → save 정책. 이 토픽은 인메모리 라이브 상태와 순수 변이만 다룬다.
- 마법 데미지와 몬스터 시전 공식 → [magic](magic.md).
- **의도적 미이식(#82 계승)**: 크리 시 무기 파괴 굴림, 불발 시 `compute_thaco` 재계산, 숙련 XP 적립, 무기
  오브젝트의 실제 이동(낙하, 마모)은 플래그로만 드러낸다. PHASTE 가속과 PBLESS thaco는 출시본에서도 동작하지
  않는(as-shipped dead) 코드다. `update.c`의 return 2 라운드 재시작은 이식하지 않았다.

### 오라클과 다른 구현 (as-built)

오라클과 의도적으로 다르게 만든 부분이다(포팅 원칙에 따라 드러내 놓고 고친 것).

- **PFEARS 우선순위 버그 수정**: 오라클 `ff = 40 + ... + (class==PALADIN) ? -10 : 0`은 C 연산자
  우선순위상 `+`가 `?:`보다 먼저 묶인다. 그래서 조건이 항상 truthy가 되어 늘 `ff=-10`이고, PFEARS 플레이어는
  사실상 매 라운드 무조건 도주한다. 명백한 버그다. `flee.ts`는 삼항을 괄호로 묶어(`... + (class===PALADIN ? -10 : 0)`)
  hp 비율, 건강, 팔라딘 보정이 실제로 도주 확률에 반영되게 고쳤다(정수 나눗셈은 유지).
- **cp 미초기화 버그는 재현하지 않음**: 오라클 `die_crt`의 그룹킬 판정 변수 `cp`는 선언만 하고 할당하지 않은
  포인터 버그다. `distributeCreatureDeath`는 이를 재현하지 않고 `contributors.length >= 2`(기여자 2명 이상)로
  결정적으로 대체한다.
- **독 공식 단일화**: 오라클의 harm-room 변형(`mrand(1,4)`)을 줄여, `resolvePlayerDot`은 어느 분기든
  `MAX(1, rng(1, trunc(hpmax/5)) - con)` 공식 하나를 쓴다.
- **성향 페널티는 기여자마다 적용**: `distributeCreatureDeath`는 오라클 `die_crt` 루프 내부와 똑같이
  alignment 페널티를 살해자 1인이 아니라 기여자마다 적용한다. 실제 동작(behavioral truth)을 따랐다.
- **breath-replace(additive 아님)**: 브레스가 발동하면 breath 데미지가 normal melee를 **대체**한다(`??`
  lazy). `monsterDamage`는 breath가 발동하지 않았을 때만 굴린다.
- **aggro 레벨 게이트 통일**: 오라클 `low_piety_alg`에는 레벨 게이트를 weight-sum 패스에만 적용하고 pick
  패스에서는 빠뜨리는 two-pass desync 버그가 있다. `selectAggroTarget`은 eligible set을 1회만 계산하고
  weight-sum과 pick 모두 이 집합에서 파생한다.
- **기여자 기준 divergence(오라클보다 좁음)**: 오라클 분배 루프의 게이트는 `find_who(ep->enemy)`다. 즉 그 자리에
  있는지(present)만 보고 데미지는 보지 않는다. 그래서 present인 0-데미지 적도 exp(버림 후 0), 성향 페널티,
  groupkill 카운트를 받는다. 이 포트는 기여자를 `damage > 0`으로 좁혀 그런 적을 뺀다. 즉 awards, groupkill,
  alignment가 present 기준이 아니라 damage 기준으로 게이팅된다. 라이브 조립(#99)에서 이 기준을 present
  기준으로 다시 검토할 수 있다.
- **골드 드롭 표현**: 별도 room 필드 없이 골드를 `ItemInstance(value=금액)`로 만들어 `room.items[]`에
  떨어뜨린다(`RoomNode.items`의 실제 원소 타입은 `ObjectInstance`가 아니라 `ItemInstance`다). roomState
  스키마는 넓히지 않는다.
- **rng 순서 divergence(inert)**: 특수공격 게이트 순서(MBRETH→breath|drain→MPOISS→MDISEA→MBLNDR→
  MDISIT)는 오라클과 정확히 같다. 다만 `monsterDamage`(melee)는 오라클처럼 중간에 굴리지 않고, `??` 지연
  때문에 post-status 게이트 **뒤**에 굴린다. status 게이트가 melee 값과 무관하므로 동작에는 영향이 없다(behaviorally inert).

## 관련 문서

- oracle: `docs/notes/game-analysis-20260625/a5-combat.md` §5~7·§9
- 의존 스펙: [stats-core.md](stats-core.md)(파생 thaco/AC·테이블·hp 상한) · [creature-spawn.md](creature-spawn.md)(활성 집합·`onCombatTick`/`onCreatureDeath` seam·`CreatureInstance`) · [persistence.md](persistence.md)(`characterSchema` 영속 필드·`statusEffects` v4) · [runtime-foundation.md](runtime-foundation.md)(1Hz `WorldClock`) · [progression.md](progression.md)(`applyPlayerDeath`·재생 슬롯 — DoT xor·사망 분배가 접합할 경계)
- 후속: #99(전투/마법 tick production boot 연결 — ledger per-creature 라우팅·특수공격 실적용·DoT xor 조립·사망 분배 실누적·aggro/flee dispatch) · #86(아이템·장비 — 장비용해·마모 substrate) · #100(offensive spell_fail 연결) · [magic.md](magic.md)(마법 코어 — `castSpell`·`fireDeath` seam 소비)
