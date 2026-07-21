# combat — 근접 전투 해결

> 무한의 4중 인라인 복제 근접 전투를 단일 `resolveAttack` 파이프로 통합하고, creature-spawn의 `onCombatTick` seam에 얹어 몬스터 구동 라운드·플레이어 반격을 실행하는 서버 전투 계층(E6a-1, 이슈 #82).

## 개요

무한의 근접 전투는 **몬스터 틱 구동 라운드**다. 플레이어의 `attack` 명령은 전투를 *개시*할 뿐(오프너 1타 + 적대 등록)이고, 이후 라운드는 중앙 1Hz 틱이 활성 몬스터를 순회하며 각 몬스터를 자기 케이던스(민첩 기반 2~3초)로 때리고, 그 몬스터의 적 리스트에 오른 플레이어들이 자기 `LT_ATTCK` 쿨다운으로 자동 반격하는 방식으로 전진한다. 플레이어에게 독립 "초당 공격 스케줄러"는 없다 — 플레이어 피해는 전부 몬스터 틱에 접힌 반격이다.

원본의 명중·피해 코드는 플레이어 근접(`command5.c attack_crt`)과 몬스터 근접(`update.c update_active` 인라인)에 **4중으로 인라인 복제**돼 있다. 이 계층은 그 복제를 단일 `resolveAttack(attacker, defender, ctx)` 파이프로 통합하고, 스케일 차이(`mrand(1,30)` vs `mrand(1,20)`·피해식·크리티컬 유무)를 `attacker.kind`로 분기한다.

핵심 분리: **공식·수치·라운드 박자·게이트 의미는 콘텐츠**(충실히 이식), **연결 리스트 순회·인라인 복제·초 단위 폴링은 형상**(재설계). 전투가 참조하는 파생 스탯(플레이어 thaco/AC)은 [stats-core](stats-core.md)가 순수 함수로 확정한 값을 **소비만** 하며(재구현 금지), 몬스터 operand·활성 집합·틱은 [creature-spawn](creature-spawn.md)이 확정한 런타임 위에 선다.

`packages/server/src/combat/`에 위치한다 — 라이브 인스턴스(`CreatureInstance`)·RNG·stats-core를 소비하므로 server에 두고, 순수 공식 하위 모듈로 테스트 가능성을 확보한다.

## 모듈 구조

| 모듈 | 책임 |
|------|------|
| `dice.ts` | `dice(n,s,p,rng)=p+Σⁿrng(1,s)`·`mdice(entity,rng)` 프리미티브. `CombatRng` seam(`(min,max)=>number`, mrand 관례)·`DiceSpec` 타입. `rng` 필수 파라미터(기본값 없음 — 조용한 최소 굴림 축소 방지). |
| `constants.ts` | 튜닝 상수 — 크리티컬 배수 범위(3~6)·명중 굴림 상한(플레이어 30·몬스터 20)·PvP 쿨다운 증분(+3)·MMAGIC 시전 확률(20%)·반격 쿨다운(기본 1초·실명 6초)·클래스 인덱스(BARBARIAN/CLERIC/MAGE/PALADIN/INVINCIBLE/CARETAKER). |
| `playerState.ts` | `PlayerCombatState`(라이브 플레이어 전투상태)·`WeaponDamage` 타입 + `toPlayerCombatState` 조립 헬퍼. |
| `combatRegistry.ts` | `CombatRegistry` — characterId-keyed 라이브 전투상태 인메모리 저장소(register/get/remove/has). |
| `combatant.ts` | `Combatant` discriminated-union 어댑터 — 플레이어(`PlayerCombatState`)·몬스터(`CreatureInstance`)를 전투 operand로 통일. `toCombatant` 오버로드. |
| `attackStats.ts` | 명중 임계값·피해 분기·PALADIN 정렬 보정(순수). 플레이어=stats-core 파생 소비, 몬스터=템플릿 read. |
| `pvp.ts` | 개시 자격 게이트(순수) — `checkTargetImmunity`(대상 무적) + `checkPvpGate`(PvP 3중). |
| `enmity.ts` | 적대 등록(`registerEnemy`)·병렬 데미지 원장(`createDamageLedger`/`accumulateDamage`). |
| `resolveAttack.ts` | 단일 파이프 `resolveAttack(attacker, defender, ctx)` — 명중→피해→크리/불발→적용, 다중공격 루프, 내구도, HP<1 death seam 발화. |
| `combatTick.ts` | `createCombatTick(deps)` — `onCombatTick` 핸들러 팩토리(몬스터 근접 + MMAGIC seam + 적 플레이어 반격). |
| `initiateAttack.ts` | 플레이어 오프너 `initiateAttack` — 개시 게이트 + `resolveAttack` 1회 + 적대 등록. |
| `index.ts` | 공개 배럴. 결정적 stub(`dice.testutil.ts`)은 test-only이므로 제외. |

## 동작

### Combatant 어댑터

`resolveAttack`의 operand는 (플레이어, 몬스터)·(플레이어, 플레이어) 조합이다. `combatant.ts`가 두 소스를 discriminated union으로 통일한다:

- 공통 표면 `CombatantBase`(`hpCurrent`·`armor`·`thaco`·`dexterity`·`flags`)만으로 명중 임계 계산이 `kind` 비대칭을 흡수한다. `flags`는 양측 hex string으로 통일해 `F_ISSET(combatant.flags, bit)` 단일 관용을 성립시킨다(원작에서 플레이어도 creature 구조체).
- 피해 계산은 kind별 추가 필드(플레이어=weapon/class/str, 몬스터=ndice/sdice/pdice)를 요구하므로, 공통 인터페이스를 부풀리지 않고 union이 원본 참조(`state`/`instance`)를 담는다.
- `hpCurrent`는 어댑트 시점 **스냅샷**(읽기 operand)이다. 피해 적용(in-place 차감)은 원본 참조(`state`/`instance`)를 통해 수행한다 — `toCombatant`는 스냅샷 뷰이므로 여기로 차감하지 않는다.

플레이어가 파생 스탯을 "계산"하고 몬스터가 템플릿을 "읽는" 비대칭을 어댑터가 흡수한다. 몬스터 operand의 전투 스탯(`armor`/`thaco`/`ndice`/`sdice`/`pdice`)은 creature-spawn `CreatureInstance` 필드로 확장돼 물질화 시점에 소스 JSON에서 옮겨진다(embedded 몬스터는 `templateId=null`이라 재조회 불가).

### `resolveAttack` 파이프 (단일 타격 → 라운드)

`resolveAttack` 한 번 = 다중공격 count만큼의 타격 루프. 순수 함수이며 전역 상태·`Date.now`·`Math.random` 없이 모든 랜덤을 `ctx.rng`(주입 `CombatRng`)로만 굴린다. 유일한 in-place 변형은 defender HP 차감(worldGraph 승인 carve-out)·ledger 누적이며 `AttackOutcome`은 매번 새 객체다.

**진입 가드**: defender HP<1이면 굴림 전에 no-op 반환한다(`DEAD_DEFENDER_NOOP`) — stale/재진입 공격이 오버킬로 음수가 된 HP에서 death seam을 재발화(#83 소환·분배 중복)하거나 음수 ledger를 누적하는 것을 차단한다. 원작은 `die()`가 대상을 즉시 제거해 재공격이 구조적으로 불가능하나, 이 포트는 사망 제거를 커넥션 계층으로 유예하므로 가드가 필요하다.

단일 타격 처리(`attacker.kind`로 스케일 분기):

| 단계 | 플레이어 attacker | 몬스터 attacker |
|------|-------------------|-----------------|
| 명중 임계 | `n = thaco − trunc(armor/8)`, PFEARS +2, PBLIND +5 | `n = max(1, thaco − trunc(armor/8))` |
| 명중 굴림 | `rng(1,30) >= n` (`HIT_ROLL_MAX_PLAYER`) | `rng(1,20) >= n` (`HIT_ROLL_MAX_MONSTER`, 더 좁음) |
| 피해 | 무기: `mdice(무기)+bonus[힘]+trunc(profic/10)` · 바바리안/초인: `mdice(self)+bonus+trunc((level+3)/4)` · MAGE/CLERIC override: 숙련·성장 항 제거 후 재굴림 | `mdice(self) − trunc((70−armor)/5)`, `<1`이면 1, MBEFUD면 `trunc(n/3)` |
| 정렬 보정 | PALADIN: `alignment<0`→`trunc(n/2)`, `>250`→`n+rng(1,3)` | 없음 |
| 크리티컬 | `rng(1,100) <= mod_profic` 또는 무기 OALCRT → `n *= rng(3,6)` | 없음 |
| 불발 | 미크리 & 무기 착용 시 `rng(1,100) <= (5−mod_profic)` & 비 OCURSE → `n=0`·무기 낙하 플래그 | 없음 |
| 적용 | 플레이어 정상타만 `max(1,n)`. 내구도 `rng(0,3)===0`이면 durabilityHit | 몬스터 반환값 재클램프 없음(MBEFUD 0 피해 보존) |
| 다중공격 | 초인 전용 `count` 증가 루프(PUPDMG) | 단타 |

- **파생값 정본은 stats-core**: 플레이어 `thaco`=`computeThaco`, `armor`=`computeAc`, `bonus[]`=`bonusOf`, 크리티컬 확률 `mod_profic`=`trunc(proficiency / proficDivisorOf(class))`. 재구현하지 않고 소비한다.
- **byte-fidelity**: 모든 `/`는 C 정수 나눗셈 = `Math.trunc`(음수 피제수에서 `Math.floor`와 갈려 명중/피해가 뒤집히므로 `floor` 금지).
- **RNG 소비 순서 고정**: 크리 굴림 `rng(1,100)`은 오라클 `||` 좌변이라 OALCRT 자동크리에도 항상 소비된다. 불발 굴림은 미크리 & 무기 착용 시에만 소비한다. 다중공격 count 굴림은 타격 루프 이전에 소비된다.
- **HP<1 감지**: 명중 타격 후 `defenderHp < 1`이면 `died` set + kind별 death seam(`fireCreatureDeath`/`firePlayerDeath`) 정확히 1회 발화 + break(오라클 `die()` 후 return).
- **ledger 누적**: defender가 몬스터일 때만 `accumulateDamage`. 크레딧은 `Math.max(0, Math.min(hpBefore, n))`로 오버킬 캡 + 음수 하한.

### 몬스터 구동 틱 (`onCombatTick`)

`createCombatTick(deps)`가 deps를 클로저 바인딩해 creature-spawn의 `onCombatTick` 핸들러를 만든다. `creatureTick` 슬롯이 `nextActionAt` 도래 + 게이트(적 있거나 공격형) 통과 크리처마다 이 핸들러를 호출한다.

라운드 동작:
1. 적 없으면(`enemies.length===0`) 즉시 종료(선공 타깃 선정은 #83).
2. **present 적 해소**: `enemies` 순서를 보존하며 방 `occupants`에 있고 레지스트리에 등록된 플레이어만 수집. "첫 적"은 `enemies[0]`이 아니라 첫 present 플레이어다.
3. **MMAGIC 분기**: `MMAGIC && !MCHARM`이면 `rng(1,100) <= 20`(`MONSTER_SPELL_CAST_CHANCE`) 통과 시 `castSpell` seam 호출 — `'cast'` 반환이면 그 라운드 근접만 스킵(반격은 유지). 기본 seam은 `'none'`(근접 진행). 마법 데미지 공식은 범위 밖(#84/A6).
4. **몬스터 근접**: `resolveAttack(creature, target, ctx)`.
5. **플레이어 반격**: present 적마다 독립 반응. `nextAttackAt > now`(쿨다운 미도래)면 스킵, 통과 시 `resolveAttack(player, creature, ctx)` 후 `nextAttackAt = now + (PBLIND ? 6 : 1)`. 몬스터가 이전 반격에 사망하면(`hpcur<1`) break(death seam 중복 방지).

`onCombatTick`은 몬스터 케이던스(`nextActionAt`)를 절대 읽거나 쓰지 않는다 — 케이던스 재스케줄은 `creatureTick` 슬롯이 소유하고, 플레이어 반격 쿨다운은 별도 필드 `nextAttackAt`으로만 관리한다. 실 배선은 반드시 `creatureTick`과 동일한 monotonic tick 소스(`deps.now`)를 읽어야 반격 빈도가 밸런스에서 이탈하지 않는다.

### 개시 게이트 (`initiateAttack` / pvp)

`initiateAttack(attacker, defender, ctx)`(플레이어 전용 오프너) = 개시 게이트 → `resolveAttack` 1회 → 적대 등록. 게이트가 막으면 `resolveAttack`를 호출하지 않고 사유를 반환한다.

- **대상 무적**(플레이어→몬스터, `checkTargetImmunity`): ① MUNKIL → 무조건 거부, ② MMGONL → 무조건 거부(마법만 유효), ③ MENONL & `class < CARETAKER` → 무기 없음 또는 `adjustment < 1`이면 거부. 통과 시 쿨다운 증분 0.
- **PvP 3중**(플레이어→플레이어, `checkPvpGate`): ① RNOKIL 안전지대 무조건 거부, ② 선악 동의 — 양측 PFAMIL이면 주입 `checkWarResult`가 게이트 적용 여부 결정(평시 패거리 보호), 아니면 적용. 적용 시 `attacker.level < 128` & 비 RSUVIV면 한쪽이라도 선(비 PCHAOS)일 때 거부. 통과 시 쿨다운 증분 +3.

관용 분리: creature/player flags는 hex string이라 `F_ISSET`로, room flags는 `number[]`라 `hasFlag`로 읽는다 — 두 표현을 입력 타입에서 각각 강제해 컴파일러가 관용 혼용을 차단한다.

게이트가 계산한 쿨다운 증분은 `cooldownIncrement`로만 표면화하며, 실 `nextAttackAt` 타이머 세팅은 WS 명령 계층 소관(범위 밖)이다. 소비자는 `now + base + cooldownIncrement`로 세팅한다.

### 라이브 플레이어 전투상태

플레이어는 방-물질화 객체(`CreatureInstance`)가 아니라 세션 액터이므로, 방 부착이 아닌 characterId-keyed `CombatRegistry`로 관리한다.

- `toPlayerCombatState(character, effectiveContext, weaponDamage)`가 `characterSchema` base + stats-core 파생(`armor=computeAc`, `thaco=computeThaco`)으로 `PlayerCombatState`를 조립한다.
- **가변 carve-out**: 이 객체는 가변이다. 전투 resolver가 `hpCurrent`/`mpCurrent`/`nextAttackAt`을 in-place 갱신하고, 레지스트리는 그 참조를 보유한다(`get`이 register된 동일 참조 반환).
- `nextAttackAt`은 몬스터의 `nextActionAt`과 구분되는 별도 필드(플레이어 세션 액터 타이머)다.

세션 lifecycle 콜사이트 배선(월드 입장 시 register / 퇴장 시 remove)은 커넥션 계층 글루로 범위 밖이다.

### seam 소비·제공

| 방향 | seam | 계약 |
|------|------|------|
| 소비 | stats-core `computeThaco`/`computeAc`/`bonusOf`/`proficDivisorOf` + 테이블 | 플레이어 파생 전투 스탯 |
| 소비 | creature-spawn `CreatureInstance`·`nextAction` 케이던스·`activeSet` | 몬스터 operand·틱 케이던스·활성 집합 |
| 채움 | creature-spawn `onCombatTick(creature, room)` | 몬스터 라운드 실행(no-op → 구현) |
| 발화 | creature-spawn `onCreatureDeath`, 플레이어 사망 seam(#81) | HP<1 감지 시(제거·분배는 후속 토픽) |
| 제공 | `castSpell` seam(#84), `DamageLedger`(#83) | 후속 토픽 소비 |

## 제약사항 / 범위 밖

- **사망 분배·특수공격·DoT·전투 AI → #83**. HP<1 감지·death seam 발화·기여 데미지 원장 누적까지만. 경험치 분배·전리품·`cp` 그룹킬 보너스·몬스터 특수공격 6종·상태이상 DoT·선공 aggro 타깃 선정은 #83.
- **마법 데미지 → #84/A6**. 몬스터 MMAGIC 시전 게이트 seam(`castSpell`)만 남기고 데미지 공식은 다루지 않는다.
- **`hpCurrent`/`mpCurrent`/`level` 변이 의미론 → #81**. 레벨업/다운·재생·exp 손실·부활은 #81. 이 계층은 필드 정의·시딩·전투 차감만.
- **플레이어 WS 명령 배선 → 명령 에픽**. `initiateAttack` 함수는 제공하나 "공격 <대상>" 파싱·라우팅·권한, `nextAttackAt` 실 타이머 세팅은 범위 밖.
- **영속 write-back → save 경로**. 전투 중 `hpCurrent` 변경의 DB 저장은 save 정책 소관. 인메모리 라이브 상태만.
- **의도적 미이식**: 크리 시 무기 파괴 굴림·불발 시 `compute_thaco` 재계산·숙련 XP 적립·무기 오브젝트 실 이동(낙하·마모)은 플래그로만 표면화. PHASTE 가속·PBLESS thaco는 as-shipped dead(stats-core 승계). 몬스터 도주(MFLEER)·`update.c` return 2 라운드 재시작 미이식.

### 구현 발산 (as-built)

- **MMGONL/MENONL 실패 공격 aggro 미등록(#91 추적)**: `initiateAttack`가 무적 게이트 실패 시 `registerEnemy` 전에 즉시 반환한다. 오라클 `add_enm_crt`는 MUNKIL 거부 뒤·MMGONL/MENONL 거부 앞에 위치해 마법무기 전용 몬스터가 실패한 물리 공격에도 적대를 등록하나(이후 틱 반격), `checkTargetImmunity`가 세 무적 플래그를 단일 무조건-거부 게이트로 번들해 이 인터리브를 재현하지 못한다. 게이트 분해(MUNKIL=pre / MMGONL·MENONL=post 등록)는 별도 패치(#91).
- **combatTick 라운드 순서 근사**: 오라클은 다른 적 반격 → target 반격 last, 근접에 죽어가는 target도 마지막에 반격(막타치면 target 생존), target 사망 판정을 end-of-round로 지연한다. 현재 구현은 `resolveAttack` 내부 즉시 death 발화 위에 서므로 target-first + 근접 즉시 사망(막타 생존 미재현)으로 근사한다. death seam은 어느 쪽이든 정확히 1회 발화하므로 무해하며, 충실 라운드 순서는 #91 후속.
- **데미지 원장 멤버십 게이트 소실(D5)**: 오라클 `add_enm_dmg`는 적 리스트 멤버에만 누적하나, 병렬 `DamageLedger` 분리로 이 게이트가 사라져 임의 attackerId에 누적한다("원장 엔트리 ⊄ enemies" 가능). 실사용은 무해(오프너가 `registerEnemy` 후 누적) — 멤버십 게이팅·분배는 #83 resolver 소관.

## 관련 문서

- oracle: `docs/notes/game-analysis-20260625/a5-combat.md`
- 의존 스펙: [stats-core.md](stats-core.md)(파생 thaco/AC·테이블) · [creature-spawn.md](creature-spawn.md)(활성 집합·`onCombatTick`/`onCreatureDeath` seam·`CreatureInstance`) · [persistence.md](persistence.md)(`characterSchema` 영속 필드) · [runtime-foundation.md](runtime-foundation.md)(1Hz `WorldClock`)
- 후속: #83(전투 부가 — 특수공격·DoT·사망 분배·전투 AI) · #81(진행 루프 — 변이 의미론) · #84(마법 코어 — `castSpell` seam 소비) · #91(라운드 순서·MMGONL/MENONL aggro 충실 패치)
