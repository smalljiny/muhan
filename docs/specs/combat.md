# combat — 근접 전투 해결·특수공격·사망 분배·전투 AI

> 무한의 4중 인라인 복제 근접 전투를 단일 `resolveAttack` 파이프로 통합하고(#82, E6a-1), 그 위에 몬스터
> 특수공격 6종·상태이상 DoT·몬스터 사망 후처리(exp·정렬·전리품)·전투 AI 타깃선정/도주·#91 라운드순서
> 충실화를 얹은(#83, E6a-2) 서버 전투 계층. 순수 로직·seam 레벨까지 구현하며, production boot 배선·라이브
> dispatch는 #99가 소유한다.

## 개요

무한의 근접 전투는 **몬스터 틱 구동 라운드**다. 플레이어의 `attack` 명령은 전투를 *개시*할 뿐(오프너 1타 +
적대 등록)이고, 이후 라운드는 중앙 1Hz 틱이 활성 몬스터를 순회하며 각 몬스터를 자기 케이던스(민첩 기반
2~3초)로 때리고, 그 몬스터의 적 리스트에 오른 플레이어들이 자기 `LT_ATTCK` 쿨다운으로 자동 반격하는
방식으로 전진한다. 플레이어에게 독립 "초당 공격 스케줄러"는 없다 — 플레이어 피해는 전부 몬스터 틱에 접힌
반격이다.

원본의 명중·피해 코드는 플레이어 근접(`command5.c attack_crt`)과 몬스터 근접(`update.c update_active`
인라인)에 **4중으로 인라인 복제**돼 있다. 이 계층은 그 복제를 단일 `resolveAttack(attacker, defender, ctx)`
파이프로 통합하고, 스케일 차이(`mrand(1,30)` vs `mrand(1,20)`·피해식·크리티컬 유무)를 `attacker.kind`로
분기한다. 그 위에 몬스터 특수공격(브레스 등 6종)·상태이상 DoT·사망 시 exp·정렬·전리품 분배·전투 AI(선공
타깃선정·도주)를 얹어, `resolveAttack`이 감지·발화만 하던 죽음과 타격을 **결과**로 완성한다.

핵심 분리: **공식·수치·라운드 박자·게이트 의미는 콘텐츠**(충실히 이식), **연결 리스트 순회·인라인
복제·초 단위 폴링·데이터 표현(hex flags→명명 필드, floor 골드→오브젝트 드롭)은 형상**(재설계). 전투가
참조하는 파생 스탯(플레이어 thaco/AC)은 [stats-core](stats-core.md)가 순수 함수로 확정한 값을 **소비만**
하며(재구현 금지), 몬스터 operand·활성 집합·틱은 [creature-spawn](creature-spawn.md)이 확정한 런타임 위에
선다.

**순수 로직·seam 레벨 경계**: 이 계층은 규칙(확률 게이트·공식·순서·데이터 계약)까지만 구현한다.
production boot에서 누가 이 seam들을 조립하는지(health-pulse xor 접합·특수공격 status 실적용·exp/정렬
실누적·전리품 방 floor push·flee/aggro dispatch)는 전부 #99가 소유한다. 각 함수는 무엇을 반환하는지로
자신의 계약을 표현하며, 호출부 부재는 결함이 아니라 설계다(`creatureDeath.ts`·`progression/death.ts`
선례).

`packages/server/src/combat/`에 위치한다 — 라이브 인스턴스(`CreatureInstance`)·RNG·stats-core를
소비하므로 server에 두고, 순수 공식 하위 모듈로 테스트 가능성을 확보한다. flag 상수는
`packages/server/src/world/hexFlags.ts`(hex string, `F_ISSET`)·`world/roomFlags.ts`(`number[]`,
`hasFlag`)에 정본으로 모은다.

## 모듈 구조

| 모듈 | 책임 |
|------|------|
| `dice.ts` | `dice(n,s,p,rng)=p+Σⁿrng(1,s)`·`mdice(entity,rng)` 프리미티브. `CombatRng` seam(`(min,max)=>number`, mrand 관례)·`DiceSpec` 타입. `rng` 필수 파라미터. |
| `constants.ts` | 튜닝 상수 — 크리티컬 배수(3~6)·명중 굴림 상한(플레이어 30·몬스터 20)·PvP 쿨다운 증분(+3)·MMAGIC 시전 확률(20%)·반격 쿨다운(기본 1초·실명 6초)·클래스 인덱스. |
| `playerState.ts` | `PlayerCombatState`(라이브 플레이어 전투상태)·`WeaponDamage` 타입 + `toPlayerCombatState` 조립 헬퍼. |
| `combatRegistry.ts` | `CombatRegistry` — characterId-keyed 라이브 전투상태 인메모리 저장소(register/get/remove/has). |
| `combatant.ts` | `Combatant` discriminated-union 어댑터 — 플레이어(`PlayerCombatState`)·몬스터(`CreatureInstance`)를 전투 operand로 통일. `toCombatant` 오버로드. |
| `attackStats.ts` | 명중 임계값·피해 분기·PALADIN 정렬 보정(순수). 플레이어=stats-core 파생 소비, 몬스터=템플릿 read. |
| `pvp.ts` | 개시 자격 게이트(순수) — `checkTargetImmunityPre`(MUNKIL) + `checkTargetImmunityPost`(MMGONL/MENONL) + `checkPvpGate`(PvP 3중). |
| `enmity.ts` | 적대 등록(`registerEnemy`)·병렬 데미지 원장(`createDamageLedger`/`accumulateDamage`). |
| `resolveAttack.ts` | 단일 파이프 `resolveAttack(attacker, defender, ctx)` — 명중→피해→특수공격 훅→크리/불발→적용, 다중공격 루프, 내구도. **fire-free**(died 반환, death seam은 호출자 소유). |
| `specialAttack.ts` | 몬스터 특수공격 6종(브레스·에너지드레인·독·질병·실명·장비용해) 확률 게이트·효과의 순수 이식 — `resolveSpecialAttack`. |
| `statusEffects.ts` | 명명 상태이상(poison/disease/blind)의 부여·만료 순수 헬퍼 + 명명 필드 → combat flag hex 뷰 투영(`projectStatusFlags`). |
| `dot.ts` | `resolvePlayerDot(char, room, ctx)` — 독/질병/위험방 DoT damage-only resolver. `dotApplied` 반환으로 재생과의 xor 계약 확정. |
| `deathDistribution.ts` | `distributeCreatureDeath(dead, room, ledger, deps)` — 데미지비례 exp 분배·정렬 보정·전리품/골드 드롭을 순수 계산해 반환. |
| `aggro.ts` | `selectAggroTarget`/`dexEvades`/`resolveAggro` — 선공 가중 랜덤 타깃선정 + 민첩 회피. |
| `flee.ts` | `decideFlee` — PWIMPY/PFEARS 도주 결정(순수, boolean 반환). |
| `combatTick.ts` | `createCombatTick(deps)` — `onCombatTick` 핸들러 팩토리(몬스터 근접 + MMAGIC seam + 적 플레이어 반격 + #91 라운드순서). |
| `initiateAttack.ts` | 플레이어 오프너 `initiateAttack` — 개시 게이트(pre/post 무적 분해) + `resolveAttack` 1회 + death ripple + 적대 등록. |
| `index.ts` | 공개 배럴 — dice/constants/playerState/combatRegistry/combatant/attackStats/pvp/enmity/resolveAttack/combatTick/initiateAttack. 6개 신규 순수 모듈(specialAttack·statusEffects·dot·deathDistribution·aggro·flee)은 내부 소비 전용이며 라이브 조립(#99) 전까지 배럴 표면에 없다. |

`world/hexFlags.ts`(크리처/플레이어/오브젝트 hex flags — 특수공격 관련 M-flag 8개(브레스 3비트 포함, MBRETH/MBRWP1/MBRWP2/MENEDR/MPOISS/MDISEA/MDISIT/MBLNDR)·PPOISN/PDISEA/PBLIND·
PWIMPY/PHIDDN/PINVIS/PDMINV·MAGGRE/MGAGGR/MEAGGR/MDINVI)와 `world/roomFlags.ts`(위험방·realm
`number[]` flags — RPHARM/RPPOIS/RPMPDR/RPBEFU·REARTH/RWINDR/RFIRER/RWATER)가 이 토픽에서 새 상수를
추가했다. 두 모듈은 서로 다른 엔티티(크리처/플레이어 vs 방)의 flags라 비트 값이 겹쳐도 무해하다.

## 동작

### Combatant 어댑터

`resolveAttack`의 operand는 (플레이어, 몬스터)·(플레이어, 플레이어) 조합이다. `combatant.ts`가 두
소스를 discriminated union으로 통일한다:

- 공통 표면 `CombatantBase`(`hpCurrent`·`armor`·`thaco`·`dexterity`·`flags`)만으로 명중 임계 계산이
  `kind` 비대칭을 흡수한다. `flags`는 양측 hex string으로 통일해 `F_ISSET(combatant.flags, bit)` 단일
  관용을 성립시킨다(원작에서 플레이어도 creature 구조체).
- 피해 계산은 kind별 추가 필드(플레이어=weapon/class/str, 몬스터=ndice/sdice/pdice)를 요구하므로,
  공통 인터페이스를 부풀리지 않고 union이 원본 참조(`state`/`instance`)를 담는다.
- `hpCurrent`는 어댑트 시점 **스냅샷**(읽기 operand)이다. 피해 적용(in-place 차감)은 원본
  참조(`state`/`instance`)를 통해 `combatantHp`/`applyCombatantDamage`로 수행한다.

몬스터 operand의 전투 스탯(`armor`/`thaco`/`ndice`/`sdice`/`pdice`)에 더해 `experience`/`alignment`
선택 필드가 `CreatureInstance` 물질화 필드로 추가됐다(사망 분배가 읽는다) — embedded 몬스터도
`creatures.json`의 실값을 항상 채우고, 다수 테스트 인라인 리터럴의 컴파일 파괴를 피하기 위해 선택
필드로 두고 `distributeCreatureDeath`가 `?? 0` 폴백으로 읽는다.

### `resolveAttack` 파이프 — fire-free 단일 타격 → 라운드

`resolveAttack` 한 번 = 다중공격 count만큼의 타격 루프. 순수 함수이며 전역 상태·`Date.now`·
`Math.random` 없이 모든 랜덤을 `ctx.rng`로만 굴린다. 유일한 in-place 변형은 defender HP 차감(worldGraph
승인 carve-out)·ledger 누적이며 `AttackOutcome`은 매번 새 객체다.

**진입 가드**: defender HP<1이면 굴림 전에 no-op 반환한다(`DEAD_DEFENDER_NOOP`) — stale/재진입 공격이
사망 후에도 death seam을 재발화하거나 음수 ledger를 누적하는 것을 차단한다.

단일 타격 처리(`attacker.kind`로 스케일 분기):

| 단계 | 플레이어 attacker | 몬스터 attacker |
|------|-------------------|-----------------|
| 명중 임계 | `n = thaco − trunc(armor/8)`, PFEARS +2, PBLIND +5 | `n = max(1, thaco − trunc(armor/8))` |
| 명중 굴림 | `rng(1,30) >= n`(`HIT_ROLL_MAX_PLAYER`) | `rng(1,20) >= n`(`HIT_ROLL_MAX_MONSTER`) |
| 특수공격 훅 | 없음 | 명중 직후 `resolveSpecialAttack` 게이트(아래 절) |
| 피해 | 무기: `mdice(무기)+bonus[힘]+trunc(profic/10)` · 바바리안/초인: `mdice(self)+bonus+trunc((level+3)/4)` · MAGE/CLERIC override: 숙련·성장 항 제거 후 재굴림 | `special.breathDamage ?? (mdice(self) − trunc((70−armor)/5), <1이면 1, MBEFUD면 trunc(n/3))` |
| 정렬 보정 | PALADIN: `alignment<0`→`trunc(n/2)`, `>250`→`n+rng(1,3)` | 없음 |
| 크리티컬/불발 | `rng(1,100) <= mod_profic` 또는 OALCRT → `n *= rng(3,6)`. 미크리&무기 착용 시 `rng(1,100) <= (5−mod_profic)` & 비 OCURSE → `n=0`·무기 낙하 | 없음 |
| 적용 | 정상타만 `max(1,n)`. 내구도 `rng(0,3)===0`이면 durabilityHit | breath 발동 시 MBEFUD 추가 `/3`(melee path와 별도 fork). 재클램프 없음 |
| 다중공격 | 초인 전용 `count` 증가 루프(PUPDMG) | 단타 |

- **파생값 정본은 stats-core**: 플레이어 `thaco`/`armor`/`bonus[]`/`mod_profic`은 재구현하지 않고
  소비한다.
- **byte-fidelity**: 모든 `/`는 C 정수 나눗셈 = `Math.trunc`.
- **RNG 소비 순서 고정**: 크리 굴림은 OALCRT 자동크리에도 항상 소비(`||` 좌변). 불발 굴림은 미크리 &
  무기 착용 시에만. 다중공격 count 굴림은 타격 루프 이전.
- **fire-free(#91, 핵심 변경)**: HP<1 감지 시 `died=true`를 세우고 break하지만, death seam(`fireDeath`)을
  **더 이상 여기서 발화하지 않는다**. 근접 라운드가 target death를 end-of-round로 지연해 "막타치면
  target 생존"을 재현하려면 즉시 발화가 불가능하기 때문이다. `fireDeath`/`ResolveContext`(`room`·`now`·
  `fireCreatureDeath`·`firePlayerDeath`·`ledger`) seam 자체는 무변경으로 유지한다 — magic
  `offensiveSpell`의 즉시-발화 경로가 동일 seam을 공유하므로 제거하면 magic이 깨진다. 발화 책임은
  `combatTick`(근접·반격)과 `initiateAttack`(오프너 킬)으로 이양됐다.
- **ledger 누적**: defender가 몬스터일 때만 `accumulateDamage`. 크레딧은
  `Math.max(0, Math.min(hpBefore, n))`로 오버킬 캡 + 음수 하한.

### 몬스터 특수공격 6종

명중 직후, `monsterDamage` **전에** `resolveSpecialAttack(attacker, defender, ctx)`을 굴린다(update.c
:387~480 오라클 게이트 순서 보존: MBRETH→breath|drain(XOR)→MPOISS→MDISEA→MBLNDR→MDISIT, 각 게이트는
플래그가 세팅됐을 때만 rng를 소비하는 단축평가).

| 특수공격 | M-flag | 확률 게이트 | 효과 | 적용 여부 |
|---|---|---|---|---|
| 브레스(4타입) | MBRETH(+MBRWP1/2) | `rng(1,30)<5` | 침(`dice(q,3,0)`)·악취+독(`dice(q,2,1)`)·냉기(`dice(q,4/2,0)`, PRCOLD 반감)·화염(`dice(q,4/2,0)`, PRFIRE 반감). `q=trunc((level+3)/4)` | **적용** — breath-replace(`??` lazy)로 normal melee를 대체, MBEFUD면 breath에도 `/3` |
| 에너지드레인 | MENEDR | `rng(1,100)<10`(브레스 미발동 시만, XOR) | `dice(q,5,q*5)` 흡수량 산출, defender.experience 상한 캡 | 흡수량 산출만 — 실 exp 차감은 substrate gap(#99, `PlayerCombatState`에 experience 필드 없음) |
| 중독 | MPOISS | `rng(1,100)<=15` | poison 마커 | 마커만 — 실 status 부여는 #99 |
| 질병 | MDISEA | `rng(1,100)<=10` | disease 마커 | 마커만 |
| 실명 | MBLNDR | `rng(1,100)<=10` | blind 마커 | 마커만 |
| 장비용해 | MDISIT | `rng(1,100)<=15` | dissolveItemRolled 마커 | 굴림만, 효과 미적용(Non-goal, #86 substrate 부재) |

브레스만 데미지로 즉시 반영되고, 나머지 5종은 `SpecialAttackResult` 마커로 `AttackOutcome.specialAttack`에
표면화될 뿐 defender를 변형하지 않는다(`resolveSpecialAttack`은 순수 — throwaway
`{flags, experience: MAX_SAFE_INTEGER}` defender shape로 굴려 실 exp 대비 상한을 실효 무효화한다). 상태
부여·exp 차감·장비용해 적용은 전부 #99가 이 마커를 읽어 수행한다. 플레이어 attacker 경로는 특수공격을
호출하지 않는다(몬스터 한정).

### 상태이상 데이터 모델·투영

`characterSchema`에 절대-틱 만료 관례(`befuddledUntil`/`charmedUntil` 미러)의 선택 `statusEffects`
필드를 추가했다(`schemaVersion` 3→4, `backfillCharacterV4`는 스탬프만 — 선택 필드라 재시딩 불필요):

- `poison`/`disease`: `{ until, interval }` — 주기 피해 상태이상.
- `blind`: `{ until }` — 명중 페널티만(주기 피해 아님).

`statusEffects.ts`가 `grantPoison`/`grantDisease`/`grantBlind`(입력 불변, 새 Character 반환)와
`isPoisonActive`/`isDiseaseActive`/`isBlindActive`(`until >= now`이면 활성)를 제공한다. 대칭 해제
헬퍼 `clearPoison`/`clearDisease`/`clearBlind`(입력 불변, 해당 필드를 제거한 새 Character 반환 —
statusEffects 없으면 입력 그대로)는 마법 cure 주문(curepoison/rm_disease/rm_blind)이 소비하며,
원본 F_CLR에 대응한다([magic-progression.md](magic-progression.md) G7 cure).
`projectStatusFlags(character, now)`가 활성 명명 필드를 combat flag hex 뷰(PPOISN/PDISEA/PBLIND)로
투영해, combat이 이미 쓰던 `F_ISSET(flags, PBLIND)` 관용을 무파괴 유지한다 — Character에는 combat
flags 필드가 없으므로 병합이 아니라 ZERO_FLAGS에서 활성 비트만 세팅한 fresh hex를 반환한다. 이 투영
함수의 실 소비(라이브 `PlayerCombatState.flags`와의 접합)는 #99 유예다.

### 플레이어 DoT

`resolvePlayerDot(character, room, ctx)`가 독·질병·위험방 DoT를 damage-only로 계산해
`{ character, died, dotApplied }`를 반환한다(입력 불변, `applyPlayerDeath` 선례).

- **독**(활성 상태이상 또는 harm-room RPPOIS): `hpCurrent -= max(1, rng(1, trunc(hpmax/5)) - bonus[체력])`.
  오라클 harm-room 변형(`mrand(1,4)`)을 이 단일 공식으로 **단일화**했다(의도적 divergence).
- **질병**(활성 상태이상): `hpCurrent -= max(1, rng(1,6) - bonus[체력])`. 공격 쿨다운 증가는
  `PlayerCombatState.nextAttackAt`(combat-state) 소관이라 Character 반환 범위 밖 — 유예.
- **위험방**(`room.flags`, `hasFlag`): RPHARM 진입 게이트 하에 RPMPDR(mp `-= min(mp,3)`)과
  realm(REARTH/RWINDR/RFIRER/RWATER) 또는 무저항 순수 RPHARM에서 `hp -= 8 - min(con,2)` 무형 피해.
  저항 게이트(PRFIRE/PBRWAT/PSSHLD/PRCOLD)는 `PlayerCombatState` substrate 부재로 미게이팅 —
  realm 피해는 항상 무저항 발동(#99 유예). RPBEFU 쿨다운은 combat-state 소관이라 미이식.
- **사망판정**: raw `hp<1`이면 `died=true`(클램프 전 판정). 반환 `character.hpCurrent`는 스키마 `min(0)`
  정합을 위해 0으로 클램프. 사망 seam 발화는 미배선(#99).
- **재생 xor 계약**: `dotApplied`가 이번 틱 hp/mp 차감 발생 여부를 알린다. progression 재생과 **같은
  LT_HEALS 슬롯을 공유해 상호배제**하는 xor 의미론을 이 반환값으로 확정한다 — `dotApplied===true`인
  틱은 재생을 skip해야 한다. 실 펄스 조립(누가 DoT resolver와 재생 provider를 xor로 접합하는가)은
  #99(또는 progression 슬롯 개정)가 소유한다.

### 몬스터 사망 exp 분배·전리품 드롭

`distributeCreatureDeath(dead, room, ledger, deps)`가 순수 함수로 `{ awards, drops }`를 계산해
**반환만** 한다(dead·room·ledger 무변형). `ledger`는 명시 파라미터로 수령하며 `fireCreatureDeath`
시그니처는 무변경이다 — 라이브 조립(누가 사망 seam에서 이 함수를 호출하는가)은 #99 소관이다.

- **기여자 집합**: `dead.enemies` 멤버 AND `ledger.get(id) > 0`인 플레이어(순서는 `enemies` 배열
  순서). 이 필터가 오라클의 적 리스트 멤버십 게이트를 분배 시점에 재현한다(§구현 발산 참조).
- **exp**: `expdiv = trunc(exp * dmg / max(hpmax,1))`. 그룹킬(기여자 2명+)이면
  `expdiv + trunc(exp/10)`, 상한 `min(., exp)`로 캡.
- **정렬**: 기여자마다 `alignmentDelta = -trunc(alignment/5)`(delta만 반환, 누적·±1000 클램프는 #99).
- **전리품**: MTRADE 몬스터는 인벤토리 드롭 없음(creature.c:311), 그 외는 `dead.inventory`를 그대로
  drops에 포함. **골드는 MTRADE 무관 항상 드롭**하며(creature.c:325, 루프 밖·무게이트),
  `ItemInstance(instanceId=\`${dead.instanceId}:gold\`, name=\`${gold}냥\`, value=gold)`로 만든다 —
  `RoomNode.items`의 실제 원소 타입이 `ItemInstance`이지 `ObjectInstance`가 아니므로, 별도 room 필드
  신설 없이 이 표현으로 roomState 스키마 무확장을 달성한다.
- **exp/alignment 소스**: `CreatureInstance.experience`/`alignment` 선택 필드(`?? 0` 폴백) — 물질화가
  `creatures.json`(port `readCrt` offset 344/324) 실값을 항상 채운다.

### 전투 AI — 선공 타깃선정·도주

`selectAggroTarget(attacker, players, rng)`이 빈-적 몬스터의 선공 대상을 **가중 랜덤**으로 뽑는다
(`lowest_piety`는 오칭 — argmin이 아니라 `weight = max(1, C - piety)` 가중 랜덤이다):

- **MAGGRE**: `C=25`, alignment/레벨 필터 없음.
- **MGAGGR**(선인 공격)/**MEAGGR**(악인 공격): `C=30`, MGAGGR→`alignment>=100`만, MEAGGR→
  `alignment<=-100`만, 레벨 게이트(`trunc((level+3)/4) >= 공격자 tier`) 추가.
- 자격 필터: PHIDDN 제외, PINVIS는 공격자 MDINVI 없으면 제외, PDMINV 무조건 제외.
- 자격자 없으면 `rng` 미굴림, `null` 반환.

`dexEvades(attacker, target, rng)`가 `target.dexterity > attacker.dexterity && rng(1,10) < 4`(30%
회피)면 해당 라운드 스킵한다(dex 열세면 단축평가로 rng 미소비). `resolveAggro`가 타깃선정→회피를
오라클 순서로 합성한다. `decideFlee(player, rng)`가 PWIMPY(`hpCurrent <= wimpyValue`, 굴림 없음) →
PFEARS(`ff` 공식 굴림) else-if 체인으로 도주 여부를 boolean으로 결정한다(§구현 발산의 PFEARS 공식
정정 참조). 두 모듈 모두 결정 로직까지만 제공하며, 실 aggro 등록(`registerEnemy`)·flee 이동 dispatch는
#99 유예다. MDINVI 은신 플레이어 탐지·몬스터 자체 도주(MFLEER)는 각각 substrate 부재·오라클
dead code라 미이식이다.

### 몬스터 구동 틱(`onCombatTick`) — #91 라운드순서

`createCombatTick(deps)`가 deps를 클로저 바인딩해 creature-spawn의 `onCombatTick` 핸들러를 만든다.
`resolveAttack`이 fire-free가 되면서(위 절) 오라클 근접 라운드 순서를 충실히 재현한다:

1. 적 없으면(`enemies.length===0`) 즉시 종료(선공 타깃선정 dispatch는 #99).
2. **stale-dead 가드**: 몬스터가 이미 HP<1이면(사망 제거가 커넥션 계층으로 유예돼 재디스패치 가능)
   즉시 종료 — death seam 재발화를 방지한다.
3. **present 적 해소**: `enemies` 순서를 보존하며 방 `occupants`에 있고 레지스트리에 등록된 플레이어만
   수집. "첫 적"은 `enemies[0]`이 아니라 첫 present 플레이어다. 틱 시작 시점 생존 여부를
   `aliveAtStart`로 스냅샷한다(counter 자격 스코핑 — 이번 라운드 근접에 죽는 target은 시작 시 생존이라
   자격 유지, stale-dead만 배제).
4. **MMAGIC 분기**: `MMAGIC && !MCHARM`이면 `rng(1,100) <= 20`(`MONSTER_SPELL_CAST_CHANCE`) 통과 시
   `castSpell` seam 호출 — `'cast'`면 그 라운드 근접만 스킵(반격은 유지).
5. **몬스터 근접(target melee)**: `doMelee`면 `resolveAttack(creature, target, ctx)`. fire-free이므로
   target이 HP<1로 떨어져도 즉시 발화하지 않고 `meleeOutcome.died`로 pending 남긴다.
6. **counter 역순**: `[...presentEnemies.slice(1), target]` — OTHER enemies 먼저, TARGET 마지막.
   `attack_crt`엔 attacker-HP 가드가 없으므로 근접에 죽어가는 target도 last에 반격을 날린다.
   `aliveAtStart`가 false인(stale-dead) 플레이어는 반격 자격이 없다. 몬스터가 어느 counter에 사망하면
   그 자리에서 `fireDeath` 1회 발화 + `monsterDied=true`로 break한다 — 오라클 `goto crt_died; if(rtn)
   continue`가 target 사망 체크를 스킵하는 것과 동일하게, **막타치면 target이 생존**한다(pending death
   취소).
7. **end-of-round target 사망 판정**: `!monsterDied && meleeOutcome?.died===true`일 때만 `fireDeath`를
   1회 발화한다.

death seam은 근접+반격 전체를 통틀어 정확히 1회 발화한다(몬스터는 counter kill 시점, target은
end-of-round 시점, 취소되지 않았을 때만). `onCombatTick`은 몬스터 케이던스(`nextActionAt`)를 절대 읽거나
쓰지 않는다 — 재스케줄은 `creatureTick` 슬롯 소유, 플레이어 반격 쿨다운은 `nextAttackAt` 필드로만
관리한다. 실 배선은 `creatureTick`과 동일한 monotonic tick 소스(`deps.now`)를 읽어야 한다.

### 개시 게이트(`initiateAttack` / pvp)

`initiateAttack(attacker, defender, ctx)`(플레이어 전용 오프너) = 개시 게이트 → `resolveAttack` 1회 →
death ripple → 적대 등록의 합성이다.

- **대상 무적, pre/post 2단계 분해**(#91): `checkTargetImmunityPre`(MUNKIL — `registerEnemy` **전**
  거부, aggro조차 등록하지 않음) → `registerEnemy` → `checkTargetImmunityPost`(MMGONL 무조건 거부 /
  MENONL & `class < CARETAKER`이면 무기 없음 또는 `adjustment < 1`일 때 거부). 오라클
  `add_enm_crt`(:153)가 MUNKIL 거부 뒤·MMGONL/MENONL 거부 앞이라, 이 분해가 "MMGONL/MENONL 몬스터에
  실패한 물리 공격도 aggro는 등록되는" 인터리브를 재현한다 — 단일 번들 게이트로는 표현 불가능했던
  동작이다. 두 단계 모두 통과 시 쿨다운 증분 0.
- **PvP 3중**(`checkPvpGate`, 변경 없음): RNOKIL 안전지대 무조건 거부 → 양측 PFAMIL이면 주입
  `checkWarResult`가 게이트 적용 여부 결정 → 적용 시 `attacker.level < 128` & 비 RSUVIV면 한쪽이라도
  선(비 PCHAOS)일 때 거부. 통과 시 쿨다운 증분 +3. 적대 등록 없음(오라클도 `add_enm_crt`를 MONSTER
  분기에만 둔다).
- **death ripple**(#91): `resolveAttack`이 fire-free이므로, `outcome.died===true`면 `initiateAttack`이
  직접 `fireDeath`를 호출한다 — 하지 않으면 오프너 킬이 loot·exp·death를 조용히 드롭한다.

관용 분리: creature/player flags는 hex string이라 `F_ISSET`로, room flags는 `number[]`라 `hasFlag`로
읽는다 — 두 표현을 입력 타입에서 각각 강제해 컴파일러가 관용 혼용을 차단한다. 게이트가 계산한 쿨다운
증분은 `cooldownIncrement`로만 표면화하며, 실 `nextAttackAt` 타이머 세팅은 WS 명령 계층 소관이다.

### 라이브 플레이어 전투상태

플레이어는 방-물질화 객체(`CreatureInstance`)가 아니라 세션 액터이므로, 방 부착이 아닌
characterId-keyed `CombatRegistry`로 관리한다.

- `toPlayerCombatState(character, effectiveContext, weaponDamage)`가 `characterSchema` base +
  stats-core 파생(`armor=computeAc`, `thaco=computeThaco`)으로 `PlayerCombatState`를 조립한다.
- **가변 carve-out**: 이 객체는 가변이다. 전투 resolver가 `hpCurrent`/`mpCurrent`/`nextAttackAt`을
  in-place 갱신하고, 레지스트리는 그 참조를 보유한다.
- `nextAttackAt`은 몬스터의 `nextActionAt`과 구분되는 별도 필드(플레이어 세션 액터 타이머)다.

세션 lifecycle 콜사이트 배선(월드 입장 시 register / 퇴장 시 remove)은 커넥션 계층 글루로 범위 밖이다.

### seam 소비·제공

| 방향 | seam | 계약 |
|------|------|------|
| 소비 | stats-core `computeThaco`/`computeAc`/`bonusOf`/`proficDivisorOf`/`resolveHpMax` + 테이블 | 플레이어 파생 전투 스탯·hp 상한 |
| 소비 | creature-spawn `CreatureInstance`·`nextAction` 케이던스·`activeSet` | 몬스터 operand·틱 케이던스·활성 집합 |
| 채움 | creature-spawn `onCombatTick(creature, room)` | 몬스터 라운드 실행 |
| 발화 | creature-spawn `onCreatureDeath`, 플레이어 사망 seam(#81) | HP<1 감지 시 호출자(`combatTick`/`initiateAttack`)가 발화 — 제거·`distributeCreatureDeath` 접합은 #99 |
| 공유 | `resolveAttack.fireDeath`·`combatant.combatantHp`/`applyCombatantDamage` | [magic](magic.md) offensive 데미지가 재사용(auto-hit — hit path 우회, 사망 1회 발화). fire-free 전환 이후에도 seam 시그니처 무변경 |
| 제공 | `castSpell` seam([magic](magic.md)이 `crtSpell`로 소비) | 몬스터 시전 게이트 |
| 제공 | `resolveSpecialAttack`·`resolvePlayerDot`·`distributeCreatureDeath`·`selectAggroTarget`/`dexEvades`·`decideFlee` | #99 라이브 조립이 소비할 순수 resolver·마커 계약 |

## 제약사항 / 범위 밖

**#99(production boot 배선)로 유예**:
- MMAGIC 시전 seam은 채워졌으나(magic), 특수공격 마커(status 부여·exp 차감·장비용해)·DoT 재생 xor
  조립·aggro 실 등록·flee 실 이동 dispatch는 이 토픽이 계산까지만 하고 배선하지 않는다.
- `distributeCreatureDeath`의 exp/alignment 실 누적·±1000 클램프·`drops`의 `room.items` push는 미배선.
- **ledger per-creature 스코핑(BLOCKING)**: `DamageLedger = Map<attackerId, number>`는 attacker키만
  갖는 defender-agnostic 구조다. `resolveAttack`이 모든 크리처 defender에 대해 이 단일 ledger에
  누적하므로, multi-monster 전투에서는 플레이어가 몬스터 B에 준 데미지가 몬스터 A 사망 보상(exp·
  alignment·groupkill 카운트)에 잘못 합산될 수 있다. `distributeCreatureDeath`는 전달된 ledger를
  "이 죽은 크리처에 스코핑된 데미지"로 **신뢰만 하고 검증하지 않는다** — #99 라이브 조립이 반드시
  per-creature ledger를 라우팅(또는 defender-scoped 뷰를 전달)해야 하는 구조적 전제다.
- 건강 펄스(health-pulse) xor 조립 위치(누가 `resolvePlayerDot`과 progression 재생 provider를 접합
  하는가)는 #99 또는 progression 슬롯 개정이 결정한다.

**Non-goal(다른 토픽 소유)**:
- 장비 용해(MDISIT)·명중 후 방어구 마모 → #86(착용 슬롯·내구도 substrate 부재).
- exp드레인의 `lower_prof`(숙련 하향) → proficiency[5] 배열(E6).
- MDINVI 은신 플레이어 탐지 → 은신 플래그 substrate 부재 토픽.
- spell_fail gate-timing 재작업 → #100.
- 플레이어 사망 페널티(exp손실·부활·레벨하락) → progression(#81) `applyPlayerDeath` 소유. 이 토픽은
  몬스터 사망 분배만.
- 몬스터 자체 도주(MFLEER)는 오라클 dead code라 미이식.
- 영속 write-back → save 정책. 인메모리 라이브 상태·순수 변이만.
- 마법 데미지·몬스터 시전 공식 → [magic](magic.md).
- **의도적 미이식(#82 계승)**: 크리 시 무기 파괴 굴림·불발 시 `compute_thaco` 재계산·숙련 XP 적립·무기
  오브젝트 실 이동(낙하·마모)은 플래그로만 표면화. PHASTE 가속·PBLESS thaco는 as-shipped dead. `update.c`
  return 2 라운드 재시작 미이식.

### 구현 발산 (as-built)

의도적 divergence(오라클 대비, 포팅 원칙에 따른 loud 정정):

- **PFEARS 우선순위 버그 수정**: 오라클 `ff = 40 + ... + (class==PALADIN) ? -10 : 0`은 C 연산자
  우선순위상 `?:`보다 `+`가 강해 항상 truthy → `ff=-10` 상시 → PFEARS 플레이어가 사실상 매 라운드
  무조건 도주하는 명백한 버그다. `flee.ts`는 삼항을 괄호로 묶어(`... + (class===PALADIN ? -10 : 0)`)
  hp비율·건강·팔라딘 보정이 실제로 도주 확률에 반영되게 정정했다(정수 나눗셈은 유지).
- **cp 미초기화 버그 비재현**: 오라클 `die_crt`의 그룹킬 판정 변수 `cp`는 선언 후 미할당인 포인터
  버그다. `distributeCreatureDeath`는 이를 재현하지 않고 `contributors.length >= 2`(기여자 2명+)로
  결정적 대체한다.
- **독 공식 단일화**: 오라클 harm-room 변형(`mrand(1,4)`)을 축약해, `resolvePlayerDot`은 어느 분기든
  `MAX(1, rng(1, trunc(hpmax/5)) - con)` 단일 공식을 쓴다.
- **정렬 페널티 기여자마다 적용**: `distributeCreatureDeath`는 오라클 `die_crt` 루프 내부 그대로,
  alignment 페널티를 기여자마다(살해자 1인이 아니라) 적용한다 — behavioral truth를 채택했다.
- **breath-replace(additive 아님)**: 브레스 발동 시 breath 데미지가 normal melee를 **대체**한다(`??`
  lazy). `monsterDamage`는 breath 미발동 시에만 굴려진다.
- **aggro 레벨게이트 통일**: 오라클 `low_piety_alg`는 레벨 게이트를 weight-sum 패스에만 적용하고
  pick 패스에 누락하는 two-pass desync 버그가 있다. `selectAggroTarget`은 eligible set을 1회 계산해
  weight-sum·pick 둘 다 이 단일 집합에서 파생한다.
- **기여자 축 divergence(오라클 대비 축소)**: 오라클 분배 루프 게이트는 `find_who(ep->enemy)`(present
  여부, 데미지 무관)라 present인 0-데미지 적도 exp(절삭 0)·정렬 페널티·groupkill 카운트를 받는다. 이
  포트는 기여자를 `damage > 0`으로 좁혀 그런 적을 제외한다 — awards·groupkill·alignment가 present
  축이 아닌 damage 축으로 게이팅된다. 라이브 조립(#99)이 이 축을 present 기준으로 재검토할 수 있다.
- **골드 드롭 표현**: 별도 room 필드 없이, 골드를 `ItemInstance(value=금액)`로 만들어 `room.items[]`에
  드롭한다(`RoomNode.items`의 실제 원소 타입이 `ItemInstance` — `ObjectInstance`가 아님). roomState
  스키마는 무확장이다.
- **rng 순서 divergence(inert)**: 특수공격 게이트 순서(MBRETH→breath|drain→MPOISS→MDISEA→MBLNDR→
  MDISIT)는 오라클 순서를 정확히 보존하나, `monsterDamage`(melee)는 오라클(중간)과 달리 `??` 지연으로
  post-status 게이트 **뒤**에 굴려진다. status 게이트가 melee 값과 독립이라 behaviorally inert하다.

## 관련 문서

- oracle: `docs/notes/game-analysis-20260625/a5-combat.md` §5~7·§9
- 의존 스펙: [stats-core.md](stats-core.md)(파생 thaco/AC·테이블·hp 상한) · [creature-spawn.md](creature-spawn.md)(활성 집합·`onCombatTick`/`onCreatureDeath` seam·`CreatureInstance`) · [persistence.md](persistence.md)(`characterSchema` 영속 필드·`statusEffects` v4) · [runtime-foundation.md](runtime-foundation.md)(1Hz `WorldClock`) · [progression.md](progression.md)(`applyPlayerDeath`·재생 슬롯 — DoT xor·사망 분배가 접합할 경계)
- 후속: #99(전투/마법 tick production boot 배선 — ledger per-creature 라우팅·특수공격 실적용·DoT xor 조립·사망 분배 실누적·aggro/flee dispatch) · #86(아이템·장비 — 장비용해·마모 substrate) · #100(offensive spell_fail 배선) · [magic.md](magic.md)(마법 코어 — `castSpell`·`fireDeath` seam 소비)
