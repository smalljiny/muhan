# A7 플레이어 진행·스탯·클래스/종족

> 무한의 플레이어 진행 체계(스탯 5종·능력치 보정·클래스/종족 효과·레벨업 곡선·hp/mp 재생)가 oracle에서 *무엇을 하는지*를 규명한다. 스탯 의미·성장 곡선·보정표는 밸런스 정의이므로 충실히 이식하고, 세이브 직렬화(디스크 구조체 → MongoDB)·유효값/기본값 미분리 필드 조작·데드코드는 형상이므로 자유롭게 재설계한다. 이슈 #7. 출처는 `legacy/muhan/src`(EUC-KR, byte-level)와 변환 산출물 `data/world/creatures.json`. 코드 이식이 아니라 동작 추출.
>
> **oracle 읽기 주의**: 하네스 `grep` 래퍼가 `-I`(binary skip)를 붙여 EUC-KR 파일을 스킵한다. `command grep -a` 또는 `iconv -f EUC-KR -t UTF-8 -c … | grep`로 우회한다([[muhan-oracle-toolchain]]).

## 개요

무한의 플레이어는 **`creature` 구조체 하나**로 표현되며, 진행 상태는 그 안의 소수 필드에 담긴다: `level`(unsigned char), `class`·`race`(char), 능력치 5종 `strength`/`dexterity`/`constitution`/`intelligence`/`piety`(각 char), `hpmax`/`hpcur`/`mpmax`/`mpcur`(short), `experience`·`gold`(long), 파생 스탯 `armor`(AC)·`thaco`, 근접 주사위 `ndice`/`sdice`/`pdice`, 그리고 성장 누적자 `proficiency[5]`(무기 숙련)·`realm[4]`(마법 숙련, [[a6-magic]]). 몬스터도 같은 구조체를 쓴다.

진행의 축은 **경험치 → 레벨**이지만 자동이 아니다. exp가 임계를 넘어도 플레이어는 **직업별 수련장(RTRAIN 방)에서 `연마`를 쳐야** 레벨이 오르고, 그때마다 gold도 소비된다. 레벨업은 hp/mp를 **폐형(closed-form) 공식으로 재계산**하고, 4레벨마다 능력치 하나를 클래스별 성장 주기표(`level_cycle`)에 따라 +1 한다.

클래스는 13종이 정의돼 있으나 **생성 시 선택 가능한 건 8종**(자객·권법가·불제자·검사·도술사·무사·포졸·도둑 = Mordor의 assassin/barbarian/cleric/fighter/mage/paladin/ranger/thief를 한국어로 재테마). 나머지는 **승급 계층**(무적 INVINCIBLE, 초인 CARETAKER)과 운영자(SUB_DM/DM)다. 레벨 100에서 무적으로 승급하며 **레벨·경험치가 1·0으로 리셋**되지만, 무적의 시작 hp/mp가 400/250으로 점프하므로 너프가 아니라 새 성장 트랙의 시작이다.

능력치는 **base와 유효값이 분리돼 있지 않다** — 버프·디버프가 `strength`/`dexterity` 등 필드를 직접 가감하고, 만료 시 되돌린다(`update_ply`). 이 필드 직접 변형이 형상 취약점의 근원이며 신규 스택의 스키마 설계를 가른다.

핵심 분리: **능력치 의미·bonus[] 보정표·class_stats 성장률·needed_exp 곡선·level_cycle 성장 주기·종족 스탯 보정·재생 공식·숙련 breakpoint는 콘텐츠**(충실히 이식), **base/유효값 미분리 필드 조작·데드코드(piety 재생 가속 주석·PBLESS thaco·up_level 증분 잔재)·디스크 구조체 직렬화는 형상**(재설계).

## 핵심 발견 요약

| # | 발견 | 분류 |
|---|------|------|
| 1 | **능력치 5종 = str·dex·con·int·piety(각 char).** 생성 시 54점 포인트바이(각 3~18, 합 ≤54), 4레벨마다 `level_cycle[class]` 주기로 +1 성장 | 콘텐츠(스탯) |
| 2 | **모든 스탯 효과는 `bonus[64]` 보정표 경유.** 스탯값(0~63)→보정(−4~+7). str→thaco·데미지·소지량, dex→AC, con→hp재생·독저항, int→mp재생·주문지속, piety→치유·기도·마법저항 | 콘텐츠(보정표) |
| 3 | **HP/MP 곡선 = `max = start + 성장률×(level−1)/2` 폐형.** class_stats[class]의 hpstart/mpstart/hp/mp가 정본. 805–808 재계산은 `level==1`·`level%4==0`에서만 도달, `level%4≠0`은 증분(779–780)이 잔존해 **폐형과 발산**(§2 형상 잔재 참조). 신규 스택은 폐형 채택(발산 수용) | 콘텐츠(곡선) / 형상(증분 드리프트 비재현) |
| 4 | **경험치 곡선 = `needed_exp[128]` 룩업.** L2=128, L36 부근 10만, L100 부근 1000만, L128=1.9억. 128 이상은 +500만/레벨 선형 | 콘텐츠(곡선) |
| 5 | **레벨업은 수동 = `연마`(train) 명령.** exp≥needed_exp[L−1] AND gold≥needed/20 AND **직업별 수련장(RTRAIN 비트 매칭)** 에서만. 조건 만족 시 여러 레벨 배치업 | 콘텐츠(규칙) |
| 6 | **승급 체계: L100→무적(레벨1·exp0 리셋, start 400/250), L127→초인(hp800/mp600 고정).** 직업전환은 별도 방에서 exp 10만 소비 후 exp_to_lev로 레벨 재동기화 | 콘텐츠(진행) |
| 7 | **클래스 = 8종 + 승급/운영.** class_stats(성장률)·thaco_list(명중)·profic/mprofic breakpoint(숙련 속도)·mod_profic 배수가 클래스별로 다름. 검사·무사 계열이 물리, 도술사가 마법 우위 | 콘텐츠(밸런스) |
| 8 | **종족 효과 = 딱 세 가지.** ① 생성 시 스탯 보정 8종(거인 힘+2/지식−1/신앙−1 등) ② 장비 크기 제한 3계급(command3) ③ 용신·난장이 암시야(room.c). 그 외 종족 효과 없음 | 콘텐츠(종족) |
| 9 | **HP/MP 재생 = LT_HEALS 5초 공용 틱.** 정상 방: hp `MAX(4,5+bonus[con]+바바리안2)`, mp `MAX(4,5+지능>17?1+메이지2)`, **틱 고정 5초**. RHEALR 방 +100·÷3. 클램프 hpmax/mpmax | 콘텐츠(자원) |
| 10 | **사망 페널티 = exp 손실만.** L<20: exp/20(5%), L≥20: exp/15(최대 10만 캡). 레벨은 클램프로 **유지**(플레이어 die는 down_level 미호출) | 콘텐츠(페널티) |
| 11 | **파생 스탯: AC=`100−5·bonus[dex]−Σ방어구−보호10`(내림차순, 낮을수록 강).** thaco=`thaco_list[class][circle]−무기−mod_profic−bonus[str]`. circle=`(level+3)/4` | 콘텐츠(공식) |
| 12 | **base/유효 스탯 미분리.** 가속(dex−15)·완력(str−3)·참선(int−3)·잠력격발(hpmax/mpmax−100) 버프가 필드를 직접 가감, 만료 시 역가감. 이중 만료·순서 의존 취약 | 형상(재설계) |
| 13 | **데드코드 다수.** piety 재생 가속(595 주석), PBLESS thaco−3(대입 후라 무효), up_level 홀짝 증분(`level%4≠0`에서 잔존·폐형과 발산하나 형상 버그로 비재현), bonus[35] 구표 주석 | 형상(비재현) |

---

## 1. 능력치 체계 (콘텐츠)

플레이어 능력치는 **5종**이며 `creature` 구조체에 각각 1바이트(char)로 저장된다(`mstruct.h:177–181`):

| 필드 | 한글(생성 UI) | 주 효과 |
|---|---|---|
| `strength` | 힘 | 명중(thaco −bonus[str]), 근접 데미지(+bonus[str]), 최대 소지량(`20+str*10`) |
| `dexterity` | 민첩 | 방어(AC −5·bonus[dex]), 은신·도둑질·함정 등 기술 확률, 추적 틱 |
| `constitution` | 맷집 | hp 재생량(+bonus[con]), 독·질병 저항(피해 −bonus[con]), 원소방 피해 감쇄 |
| `intelligence` | 지식 | mp 재생(>17이면 +1), 주문 지속시간(bonus[int], [[a6-magic]] §8), 주문 학습 |
| `piety` | 신앙심 | 치유 계열·기도·강령 확률(5·bonus[piety]), 마법저항(piety+int, [[a6-magic]] §6) |

`alignment`(short, −1000~+1000)는 별도 축으로 선/악 성향을 나타내며, 몬스터 처치·정렬 주문·PvP에서 이동한다(생성 시 `PCHAOS` 플래그로 선/악 초기 결정). 스탯이 아니라 사회·전투 게이트로 쓰인다.

### bonus[64] 보정표 — 모든 스탯 효과의 단일 경유점

능력치는 **원시값이 아니라 보정값으로** 대부분의 공식에 들어간다. `global.c:57`:

```c
int bonus[64] = { -4,-4,-4,-3,-3,-2,-2,-1,-1,-1, 0, 0, 0, 0, 1, 1,
                   1, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 4, 5, 5, 5,
                   5, 5, 5, 6, 6, 6, 6, 6, 6, 6, 6, 6, 7, 7, 7, 7,
                   7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7 };
```

인덱스 = 능력치값(0~63), 값 = 보정. 대표 구간: **3=−3, 8~9=−1, 10~13=0, 14~16=+1, 18=+2, 25=+4, 30=+5, 44+=+7**(상한). 생성 시 최대 18(=+2)에서 시작해 레벨 성장·마법·장비로 오른다.

> **형상 메모**: `bonus[35]`(구표, `global.c:54`)가 주석 처리돼 있다. 값이 다르다(예: index 16에서 구표 +1 vs 신표 +1이지만 중간 구간 상이). 이식은 활성 `bonus[64]`만 정본으로 삼는다.

`bonus[]` 인덱싱은 능력치값을 그대로 배열 첨자로 쓰므로 **63 초과 시 out-of-bounds**다. `compute_ac`(player.c:978)는 `dexterity>63`을 명시적으로 클램프하지만, 대부분의 호출처(`bonus[ply_ptr->strength]` 등)는 클램프 없이 직접 인덱싱한다 — 정상 플레이에서는 스탯이 63을 넘지 않는다는 암묵 가정이다. 신규 스택은 보정을 **함수(clamp 내장)** 로 재구현한다.

---

## 2. HP/MP 곡선 = class_stats 폐형 (콘텐츠 + 형상 잔재)

레벨업 시 hp/mp는 클래스별 성장률표 `class_stats[13]`(`global.c:37`)로 결정된다. 원소는 `{hpstart, mpstart, hp, mp, ndice, sdice, pdice}`:

| idx | 클래스 | hpstart | mpstart | hp/lv | mp/lv | 근접 ndice/sdice/pdice |
|---|---|---|---|---|---|---|
| 1 | 자객(assassin) | 55 | 40 | 5 | 2 | 1d6+0 |
| 2 | 권법가(barbarian) | 57 | 40 | 7 | 1 | 2d3+1 |
| 3 | 불제자(cleric) | 54 | 50 | 4 | 3 | 1d4+0 |
| 4 | 검사(fighter) | 56 | 50 | 6 | 1 | 1d5+0 |
| 5 | 도술사(mage) | 54 | 50 | 4 | 3 | 1d3+0 |
| 6 | 무사(paladin) | 55 | 50 | 5 | 2 | 1d4+0 |
| 7 | 포졸(ranger) | 56 | 40 | 6 | 2 | 2d2+0 |
| 8 | 도둑(thief) | 55 | 50 | 5 | 2 | 2d2+1 |
| 9 | 무적(invincible) | 400 | 250 | 4 | 4 | 2d4+0 |
| 10~12 | 관리/운영/DM | 50 | 50 | 5~7 | 4~5 | 5d5+5 |

**지배 공식**(`up_level` player.c:805–808, 주석 "기존 플레이어 데이타 갱신"):

```
hpmax = hpstart + hp × (level−1)/2      (정수 나눗셈)
mpmax = mpstart + mp × (level−1)/2
hpcur = hpmax;  mpcur = mpmax           (레벨업 시 완전 회복)
```

예시(검사 hp6/mp1, start 56/50): **L1** 56/50 → **L10** 83/54 → **L50** 203/74 → **L100** 353/99. 도술사(mage hp4/mp3): **L50** 152hp/**123mp**. 권법가(barbarian hp7/mp1): **L50** 228hp/64mp. → hp는 권법가·검사가, mp는 불제자·도술사가 앞선다.

> **형상 잔재(#3) — 정정(2026-07-16 리뷰)**: `up_level`은 폐형 재계산(805–808) 이전에 **홀짝 증분**(779–780: 홀수레벨 `hpmax+=hp`, 짝수 `mpmax+=mp`)을 먼저 수행한다. 폐형 재계산은 **`level==1` 또는 `level%4==0`에서만** 도달한다 — `level%4≠0`에서는 791행 조기 `return`이 폐형을 건너뛰므로 그 레벨의 `hpmax`/`mpmax`는 **증분 누적값 그대로 유지**된다. 이 증분값은 4의 배수 레벨에서만 폐형으로 재동기화된다.
>
> 이전 서술("증분 합 = 폐형과 수학적으로 일치")은 **틀렸다**. 조기 return 때문에 증분값과 폐형은 절반가량 레벨에서 발산한다. 전사(hpstart=56, hp=6) `hpmax` 검산: **L2** 게임56/폐형59, **L5** 게임71/폐형68, **L7** 77/74, **L9** 83/80(L1·L3·L4·L6·L8 등에서는 우연히 일치). `hpmax`는 `up_level` 안에서만 기록되고 디스크에 그대로 저장되므로(`files1.c:455–458` `read_crt`는 `hpmax`를 로드만, `update_ply`는 재계산 안 함), 이 증분값이 **실제 관측·저장되는 값**이다 — "일시적 미세 드리프트"가 아니라 영구 발산이다.
>
> **채택 결정(폐형 유지)**: 이 발산은 `level%4` 조기 return이 만든 원본의 **의도치 않은 드리프트(형상 버그)**로 판단하고, 신규 스택은 깔끔한 폐형 하나(`start + 성장×(level−1)/2`)만 구현한다. 결과적으로 신규 캐릭터·재계산된 세이브는 발산 레벨에서 원본보다 HP/MP가 다를 수 있으며(as-shipped 아님, 형상 개선), 이는 수용된 발산이다. `computeHpMax`/`computeMpMax` resolver 주석에 동일 근거를 명시한다.

---

## 3. 경험치 곡선 = needed_exp[128] (콘텐츠)

레벨 임계는 `global.c:129`의 `long needed_exp[]` 룩업이다. `needed_exp[level−1]` = **다음 레벨에 필요한 누적 경험치**.

곡선 형태(대표 지점):

| 레벨 부근 | 필요 exp(누적) |
|---|---|
| L2 | 128 |
| L10 | 1,280 |
| L36 부근 | 100,000 |
| L50 부근 | 460,992 |
| L100 부근 | 10,000,000 |
| L128 | 190,000,000 |

초반은 준(準)기하급수(레벨당 ×1.3~2), L100 근처부터 계단이 급격해진다. **레벨 128 초과**는 배열이 없으므로 `needed_exp[126] + (level−127)×5,000,000` 선형 확장(`command7.c:592`, `exp_to_lev` misc.c:472). `MAXALVL=128`(mtype.h:83).

역함수 `exp_to_lev(exp)`(misc.c:472)는 `needed_exp`를 선형 스캔해 레벨을 돌려주며, 직업전환·사망 클램프에서 레벨 재동기화에 쓰인다.

**경험치 획득원**은 [[a5-combat]]의 몬스터 처치 분배(`die`가 공격자 enemy 리스트에 데미지 비례로 분배, creature.c:19–48)와 퀘스트 보상(`quest_exp[]`, global.c)이다. 처치 exp는 참여자 레벨서클 합으로 나눠 분배되고, 마지막 일격에 `crt->experience/10` 보너스가 붙는다.

---

## 4. 레벨업 = 수동 연마 (콘텐츠 규칙)

exp가 임계를 넘어도 자동 레벨업은 없다. 플레이어는 **`연마`(train)** 명령을 쳐야 하며(`command7.c` train 핸들러), 세 게이트를 모두 통과해야 한다:

1. **장소**: 현재 방이 `RTRAIN` 플래그를 가진 수련장이고, 방의 하위 3비트(`RTRAIN+1..+3`)가 **플레이어 직업과 매칭**돼야 한다(`command7.c:565–587`). `class−1`의 하위 3비트를 방 플래그와 대조 — 즉 자객은 자객 수련장에서만, 검사는 검사 수련장에서만 오른다. `class>8`(무적 이상)은 이 게이트 면제(`if(class>8) fail=0`).
2. **경험치**: `experience ≥ needed_exp[level−1]`.
3. **돈**: `gold ≥ needed_exp[level−1] / 20`(정확히는 `(expneeded/10)/2`).

세 게이트 통과 시 **배치 레벨업 루프**(command7.c:634~): gold를 차감하고 `up_level`을 부른 뒤, 다음 임계도 만족하면 반복한다 — exp를 많이 쌓아두고 한 번에 여러 레벨을 올릴 수 있다.

### 능력치 성장 = 4레벨 주기 (level_cycle)

`up_level`은 **`level%4==0`일 때만** 능력치를 하나 올린다(player.c:791 조기 return). 어떤 스탯을 올릴지는 클래스별 10칸 주기표 `level_cycle[class][10]`(`global.c:78`)에서 `(level−2)%10` 인덱스로 정한다:

| 클래스 | level_cycle 주기(10칸) | 40레벨당 스탯 분포 |
|---|---|---|
| 자객 | CON PTY STR INT DEX INT DEX PTY STR DEX | STR2 DEX3 CON1 INT2 PTY2 |
| 권법가 | INT DEX PTY CON STR CON DEX STR PTY STR | STR3 DEX2 CON2 INT1 PTY2 |
| 불제자 | STR DEX CON PTY INT PTY INT DEX CON INT | INT3 PTY2 나머지 균등 |
| 검사 | PTY INT DEX CON STR CON INT STR DEX STR | STR3 CON2 |
| 도술사 | STR DEX PTY CON INT CON INT DEX PTY INT | INT3 CON2 |
| 무사 | DEX INT CON STR PTY STR INT PTY CON PTY | PTY3 |
| 포졸 | PTY STR INT CON DEX CON DEX STR INT DEX | DEX3 |
| 도둑 | INT CON PTY STR DEX STR CON DEX PTY DEX | DEX3 |

주기는 40레벨(=10성장×4레벨)에 한 바퀴 돌며, 클래스 특성 스탯을 편중 성장시킨다(권법가=힘, 도술사=지식, 무사=신앙). `down_level`은 정확한 역연산으로 스탯을 되돌린다.

---

## 5. 승급 체계 (콘텐츠 진행)

`연마` 안에 두 개의 **승급 분기**가 있다(command7.c:606~):

- **레벨 100 + 일반직(class < INVINCIBLE) → 무적(INVINCIBLE)**: `class=INVINCIBLE`, **`level=1`·`experience=0`으로 리셋**. 겉보기 리셋이지만 무적의 `class_stats`는 hpstart=400·mpstart=250으로 점프하므로 즉시 이전보다 강하며, 새 성장 트랙(hp4/mp4/lv)을 다시 오른다. 가족(family)이면 멤버 등급 갱신.
- **레벨 127 + 무적 → 초인(CARETAKER)**: `class=CARETAKER`, `level=127` 고정, **hpmax=800·mpmax=600·근접 4d4+4로 고정 설정**, gold 차감. 전체 브로드캐스트로 축하.

또한 **직업전환**(change class, `chg_class_main` command7.c:1149)이 별도로 존재한다: 특정 방(RTRAIN 비트로 새 직업 지정)에서 **exp 10만 소비** 후 `class`를 바꾸고, `exp_to_lev(experience)`로 목표 레벨을 계산해 초과분만큼 `down_level`을 반복 호출해 레벨을 재동기화한다. 잠력격발(PUPDMG) 상태면 연마·전환 시 자동 해제(hpmax/mpmax −100 복원).

---

## 6. 클래스 밸런스 축 (콘텐츠)

클래스는 진행 곡선(§2·§4) 외에 **명중·숙련 성장 속도**에서도 갈린다.

### thaco_list — 명중 기본값

`compute_thaco`(player.c:1001)는 `circle = (level+3)/4`(1~20으로 클램프)를 인덱스로 `thaco_list[class][circle−1]`(global.c:105)을 읽는다. 낮을수록 명중이 좋다(내림차순 THAC0). 클래스별 20서클 진행(발췌):

| 서클(레벨) | 검사(f) | 도술사(m) | 도둑(t) | 자객(a) |
|---|---|---|---|---|
| 1(L1~4) | 20 | 20 | 20 | 18 |
| 5(L17~20) | 16 | 18 | 18 | 17 |
| 10(L37~40) | 11 | 16 | 16 | 14 |
| 20(L77~80) | 3 | 11 | 11 | 9 |

→ 검사·권법가(b)가 가장 빠르게 명중이 좋아지고, 도술사가 가장 느리다. 최종 thaco:

```
thaco = thaco_list[class][circle] − 무기.adjustment − mod_profic(ply) − bonus[strength]
        일반직 L<101: MAX(0,·) / L≥101: MAX(−5,·) / 무적+: MAX(−10,·)
```

### mod_profic — 무기 숙련의 명중 기여 배수

`mod_profic`(player.c:1032)은 착용 무기 종류의 숙련%를 클래스별 배수로 나눠 thaco를 낮춘다: **검사·권법가·무적·관리=÷20**(최대 기여), 포졸·무사=÷25, 도둑·자객·불제자=÷30, 그 외(도술사)=÷40. 전사 계열이 같은 숙련으로 더 큰 명중 이득을 본다.

### profic / mprofic — 숙련 성장 속도 breakpoint

`profic`(player.c:1120, 무기)·`mprofic`(player.c:1204, 마법 realm)은 누적자(`proficiency[i]`·`realm[i]`)를 **클래스별 11구간 breakpoint 배열**로 0~100%에 선형 보간한다. 같은 100%에 도달하는 데 필요한 누적치가 클래스마다 다르다:

- **무기 숙련**(profic): 검사=가장 싸다(100%에 ~934,808), 권법가 2배, 도둑·포졸 3배, 불제자·무사·자객 ~4배, **도술사=가장 비싸다**(~6,543,656). 전사가 무기를 빨리 마스터.
- **마법 숙련**(mprofic): **도술사=가장 싸다**(realm 100%에 ~2,073,306), 불제자 다음, 무사·포졸, 그 외(비시전직)=가장 비싸다(~5,495,000). [[a6-magic]] §7의 realm 성장이 이 곡선을 오른다.

숙련 성장 자체는 [[a5-combat]](무기 명중 시 `proficiency` 누적)·[[a6-magic]](몬스터 마법 데미지 시 `realm` 누적)에서 다루며, A7은 그 누적자가 **어떻게 %로 환산되는지**(위 breakpoint)만 정본화한다.

---

## 7. 종족 = 세 가지 효과뿐 (콘텐츠)

종족은 8종이 생성 가능하다(`create_ply` command1.c:321, race_str global.c:66). Mordor 종족을 한국어로 재테마했다:

| 상수(값) | race_str | 원형 | 생성 시 스탯 보정(command1.c:338~) |
|---|---|---|---|
| DWARF(1) | 난장이족 | dwarf | 힘+1, 신앙−1 |
| ELF(2) | 용신족 | elf | 지식+2, 맷집−1, 힘−1 |
| HALFELF(3) | 요괴족 | half-elf | 지식+1, 맷집−1 |
| HOBBIT(4) | 토신족 | hobbit | 민첩+1, 힘−1 |
| HUMAN(5) | 인간족 | human | 맷집+1 |
| ORC(6) | 도깨비족 | orc | 힘+1, 맷집+1, 민첩−1, 지식−1 |
| HALFGIANT(7) | 거인족 | half-giant | 힘+2, 지식−1, 신앙−1 |
| GNOME(8) | 땅귀신족 | gnome | 신앙+1, 힘−1 |

> race_str에는 index 9 "개구리족"이 하나 더 있으나 RACE 상수(1~8)에 대응이 없고 생성 메뉴에도 없다 — dead 엔트리로 제외.

**종족의 게임 효과는 정확히 세 가지**이며(`->race` 전 파일 grep 확증), 그 외 저장·세이빙스로우·재생 등 어디에도 종족 분기가 없다:

1. **생성 시 스탯 보정**(위 표) — 포인트바이 54점 배분 *후* 적용. 종족 보정은 3~18 상·하한을 다시 체크하지 않으므로 극단 배분 시 유효 스탯이 18을 넘거나 3 미만이 될 수 있다(형상 후보).
2. **장비 크기 제한**(command3.c:173·412·779): 방어구가 3계급으로 착용 종족을 게이트 — 소형(땅귀신·토신·난장이)/대형(인간·용신·요괴·도깨비)/거인(거인 전용). 크기 불일치면 `cantwear`.
3. **암시야**(room.c:532): **용신(ELF)·난장이(DWARF)** 는 광원 없이도 어두운 방을 본다(`light=1`). 관리자(CARETAKER)+도 동일. 그 외 종족은 광원 필요.

→ 종족은 캐릭터 정체성·장비 호환·시야에만 관여하고 **성장 곡선·전투 수치에는 개입하지 않는다**. 이 "얇은 종족" 구조가 깔끔한 발견이다.

---

## 8. 캐릭터 생성 = 54점 포인트바이 (콘텐츠)

`create_ply`(command1.c:203)의 대화형 8단계:

1. **성별**(남/여) → `PMALES` 플래그.
2. **직업** 1~8 선택(자객~도둑). class_stats·thaco·숙련 곡선이 여기서 결정.
3. **능력치 포인트바이**: "54점으로 5능력치 구성, 각 3~18". 입력 `## ## ## ## ##`(힘 민첩 맷집 지식 신앙심). 검증: 각 값 3≤x≤18, 합 ≤54. 초과·범위 이탈 시 재입력.
4. **주력 무기** 1~5(도/검/봉/창/궁) → 해당 `proficiency[i]=1024`(≈숙련 시작치).
5. **성향**(선함/악함) → `PCHAOS`. 악은 PvP·도둑질 가능, 선은 보호받지만 제한.
6. **종족** 선택 → §7 스탯 보정 적용.
7. **암호** 3~14자.
8. 확정: `up_level` 1회 호출(L1 스탯 확정 = class_stats start값), `init_ply`, **gold=500** 지급, 세이브.

→ 생성 시점의 스탯 총합은 **54(포인트바이) ± 종족 보정**이다. 종족 보정이 순증(−종족 없음)인 경우가 없어(모든 종족이 +와 − 혼합, 인간만 순+1) 종족 선택은 스탯 재분배에 가깝다.

---

## 9. 파생 스탯 (콘텐츠 공식)

### 방어(AC) — `compute_ac` (player.c:971)

```
ac = 100 − 5·bonus[dexterity] − Σ(착용 방어구 armor) − (PPROTE ? 10 : 0)
     clamp [−127, 127],  creature.armor에 저장
```

**내림차순 AC**(D&D 방식) — 낮을수록 강하다. 기본 100에서 민첩 보정·방어구·보호 주문이 깎는다. dex>63은 명시적 클램프(978행).

### 명중(THAC0) — `compute_thaco` (player.c:1001) — §6 참조

### 소지량 — `max_weight` (player.c:1099)

```
max = 20 + strength×10   (+ 권법가면 circle×10 추가)
```

힘이 소지 한계를 직접 지배하고, 권법가만 레벨서클로 추가 보너스를 받는다.

---

## 10. HP/MP 재생 규칙 (콘텐츠 자원)

재생은 `update_ply`(player.c:348, 매 갱신 틱 호출)의 `LT_HEALS` 슬롯 하나로 hp·mp를 공용 관리한다. 방 성격에 따라 **세 분기**로 갈린다(player.c:587~738):

**(A) 정상 방**(RPHARM 아님 + 중독·질병 아님, 589–604):

```
hpcur += MAX(4, 5 + bonus[constitution] + (class==BARBARIAN ? 2 : 0))
mpcur += MAX(4, 5 + (intelligence>17 ? 1 : 0) + (class==MAGE ? 2 : 0))
LT_HEALS.interval = 5초  (고정)
→ RHEALR(빠른회복) 방: hp/mp 각 +100, interval /= 3
→ hpcur/mpcur는 각각 hpmax/mpmax로 클램프
```

**틱 간격은 정상 방에서 고정 5초**다. piety 기반 가속(`interval = 5 − 3·bonus[piety]`)은 **595행에서 주석 처리**돼 정상 재생에 관여하지 않는다(형상 데드코드). 재생 속도는 con(hp량)·int(mp량)·바바리안/메이지 보너스로만 갈린다.

**(B) 중독·질병 방**(RPHARM 아님 + ill, 608–638): 회복 대신 **피해**. 독=`MAX(1, mrand(1,hpmax/5)−bonus[con])`, 병=`MAX(1,mrand(1,6)−bonus[con])`, 틱 `30−3·bonus[con]`초. hp<1이면 `die`.

**(C) harm 방**(RPHARM, 641~738): 방 원소 플래그(RFIRER/RWATER/REARTH/RWINDR)와 저항 버프 대조 → 미저항이면 원소 피해, 완전 미분류 harm은 생명력 흡수. 이 분기에서만 **mp 재생 `MAX(1, 2+지능>17?1+메이지2)`**(정상보다 약함)과 **`interval = 5 − 3·bonus[piety]`(736행, 여기서는 활성)**이 산다. RPMPDR 방은 mp를 매 틱 3 감소.

→ **piety의 재생 효과는 harm 방 틱 간격에서만 유효**하다. "신앙심이 회복을 빠르게 한다"는 정상 방에는 틀린 서술이므로 이식 시 주의.

기타 update_ply 처리: 버프 만료(§12), LT_PSAVE 자동 세이브(SAVEINTERVAL), 광원 연료 소모(LIGHTSOURCE shotscur−−).

---

## 11. 사망 페널티 (콘텐츠)

플레이어 `die`(creature.c:262, PLAYER 분기 ~110–139):

```
비-PvP(몬스터/자멸) 사망:
  level < 20:  experience −= experience/20      (5%)
  level ≥ 20:  experience/15 > 100000 ? −= 100000 : −= experience/15   (~6.7%, 10만 캡)
  레벨 클램프: (level+3)/4 vs exp_to_lev(experience) 비교 후
               experience = needed_exp[level−3]로 하한 고정 → 레벨 유지
  experience = MAX(0, experience)
PvP 사망(!RSUVIV): 추가로 무기 숙련(proficiency) 손실
```

핵심: **플레이어 사망은 `down_level`을 호출하지 않는다**. exp만 깎고, 깎인 exp가 현재 레벨 임계 아래로 내려가면 `needed_exp[level−3]`로 되끌어올려 **레벨 강등을 방지**한다. `down_level`은 오직 (a) 직업전환 재동기화(command7.c:1167), (b) 몬스터 레벨 하향(creature.c:458)에서만 쓰인다. 즉 진행 곡선에서 플레이어가 잃는 것은 시간(exp)이지 레벨이 아니다.

몬스터 처치 측(die 상단, 19–48)은 반대로 공격자들에게 exp를 분배하고 alignment를 이동시킨다 — §3 경험치 획득원.

---

## 12. base/유효 스탯 미분리 = 형상 취약 (재설계)

원본은 **기본 능력치와 버프 수정치를 분리하지 않는다**. 버프가 걸리면 `creature`의 능력치 필드를 직접 가산하고, `update_ply`가 만료를 감지해 직접 역가산한다:

| 버프/상태 | 필드 직접 변형 | 만료 역연산(update_ply) |
|---|---|---|
| 가속(PHASTE) | dexterity += 15 | dexterity −= 15 (366행) |
| 완력(PPOWER) | strength += 3 | strength −= 3 (376행) |
| 참선(PMEDIT) | intelligence += 3 | intelligence −= 3 (409행) |
| 기도(PPRAYD) | piety += 5 | piety −= 5 (420행) |
| 살기(PSLAYE) | thaco −= 3 | thaco += 3 (398행) |
| 잠력격발(PUPDMG) | pdice+5·hpmax/mpmax+100 | 각 역연산(386–388), 연마·전환 시에도 해제 |

이 구조의 취약점:
- **이중 만료/이중 적용**: 버프 재적용·저장/로드 타이밍이 어긋나면 필드가 영구 드리프트(예: 만료 처리 없이 저장 후 재로그인).
- **파생 스탯 재계산 순서 의존**: dex 변형 후 `compute_ac`, str 변형 후 thaco 재계산을 수동 호출해야 정합. 누락하면 AC/thaco가 stale.
- **bonus[] 인덱스 폭주**: 버프로 dex가 63 초과 시 클램프 없는 호출처에서 OOB.

→ **신규 스택은 base 능력치 + 모디파이어 레이어를 분리**한다: `effectiveStr = baseStr + Σ activeModifiers`. 버프는 만료 이벤트를 가진 모디파이어 객체로, 파생 스탯(AC/thaco/소지량)은 유효 스탯의 **순수 함수**로 매 조회 시 계산(또는 모디파이어 변경 시 무효화). MongoDB 스키마는 `baseStats`만 영속화하고 활성 모디파이어는 라이브 상태([[muhan-mud-port]])에 둔다.

---

## 13. 형상·버그·데드코드 목록 (재설계 / 비재현 후보)

| # | 항목 | 성격 | 처리 |
|---|---|---|---|
| a | **piety 재생 가속 주석 처리**(595행) — 정상 방 틱은 고정 5초, piety 무효 | dead | 정상 재생 piety 미반영으로 이식(또는 의도 복원 결정) |
| b | **PBLESS thaco−3 데드코드**(1021–1022) — `ply_ptr->thaco` 대입(1016/1019) *이후* `thaco −= 3`이라 저장값에 반영 안 됨 | 버그 | 대입 전으로 이동하거나 축복 명중효과 재설계 |
| c | **up_level 홀짝 증분**(779–780) — `level==1`·`level%4==0`에서만 805–808 폐형에 덮이고, `level%4≠0`은 791행 조기 return으로 증분만 잔존해 **폐형과 발산**(§2 정정 참조) | 형상 버그(드리프트) | 폐형 하나로 통합, 발산 수용(비재현) |
| d | **bonus[35] 구표 주석**(54행) — 활성 bonus[64]와 값 상이 | dead | bonus[64]만 정본 |
| e | **base/유효 스탯 미분리**(§12) — 필드 직접 가감, 순서·타이밍 의존 | 구조 | 모디파이어 레이어 분리 |
| f | **종족 보정 상·하한 미재검**(command1.c:338) — 54점 배분 후 종족 ± 적용 시 3~18 벗어날 수 있음 | 결함 | 적용 후 clamp 검토 |
| g | **race_str "개구리족"(index 9)** — RACE 상수 대응 없음, 생성 불가 | dead | 제외 |
| h | **bonus[] 무클램프 인덱싱** — 대부분 호출처가 dex>63 등 체크 없이 직접 첨자 | 잠재 OOB | 보정을 clamp 내장 함수로 |
| i | **레벨은 unsigned char**(≤255) — needed_exp는 128칸, 이후 선형 확장. 진행 상한 사실상 무한 | 형상 | 레벨 타입·상한을 명시 설계 |
| j | **연마 class±1 비트 조작**(command7.c:565·575) — 수련장 매칭을 위해 class 필드를 임시 감·가산 | 구조 | 방↔직업 매핑을 선언적 테이블로 |

---

## 14. 아키텍처 함의

1. **base 스탯 + 모디파이어 레이어 분리**(§12). 진행 시스템의 최우선 재설계. 영속 필드는 base 능력치·level·exp·class·race·숙련 누적자만. 버프·장비 보정·파생 스탯(AC/thaco/소지량/재생량)은 유효 스탯의 순수 함수로 조회 시 계산. 이것이 무한을 "필드 직접 변형" MUD에서 상태 일관 서버로 옮기는 핵심.

2. **성장 데이터는 선언적 테이블**. class_stats·level_cycle·thaco_list·needed_exp·profic breakpoint·종족 보정·bonus[]는 전부 코드가 아니라 **데이터**(JSON/config)여야 한다. 곡선 튜닝이 코드 수정 없이 가능해지고, [[a6-magic]] §2(spllist/ospell 테이블화)와 같은 원칙이다.

3. **레벨업은 명령이지 자동이 아니다**(§4). 진행 파이프는 "exp 획득(전투/퀘스트) → 임계 충족 → 수련장에서 명시 연마"의 3단이며, 서버는 각 단을 이벤트로 분리한다. 자동 레벨업으로 단순화하면 원본의 수련장 경제(gold 소비·장소 게이트)를 잃는다 — 이식할지 결정 게이트 필요.

4. **승급은 별도 상태 트랙**(§5). 무적·초인은 능력치·곡선·게이트가 다른 "prestige" 계층이다. 신규 스택은 class를 (기본직 8 + prestige 계층)의 태그드 유니온으로 모델링하고, L100/L127 승급을 상태 전이로 명시한다.

5. **파생 스탯 재계산 트리거 통일**. 원본은 dex/str 변형마다 `compute_ac`/`compute_thaco`를 수동 호출한다(누락 시 stale). 유효 스탯을 함수로 만들면 이 수동 호출이 전부 사라진다.

6. **재생·버프 만료는 스케줄러로**(§10·§12). LT_HEALS 5초 틱과 버프 LT 만료는 [[muhan-mud-port]]의 JS 스케줄러/EventEmitter로 대체. 재생을 틱 이벤트로, 버프 만료를 타이머 이벤트로 발행하면 update_ply의 거대 if 체인이 해체된다.

7. **콘텐츠/형상 경계 확정.** 이식: §1 스탯 의미·bonus표·§2 hp/mp 곡선·§3 exp 곡선·§4 연마 게이트·§4 level_cycle·§5 승급·§6 클래스 밸런스·§7 종족 3효과·§8 생성 규칙·§9 파생 공식·§10 재생 공식·§11 사망 페널티. 재설계/비재현: §12 필드 미분리·§13 전 항목(데드코드·버그·구조).

---

## 검증 메모

- **직접 읽어 확인**(byte-level): `init_ply`·`update_ply`·`up_level`·`down_level`·`compute_ac`·`compute_thaco`·`mod_profic`·`profic`·`mprofic`·`max_weight`(player.c), `create_ply`(command1.c), 연마·직업전환(command7.c), `die`·`exp_to_lev`(creature.c/misc.c), 종족 게이트(command3.c·room.c). 정본 테이블 class_stats/bonus/class_str/race_str/level_cycle/thaco_list/needed_exp/quest_exp는 global.c에서 값 직접 확인.
- **핵심 주장 spot-check**: hp/mp 폐형 `start+성장×(level−1)/2`(805–808 확정; **증분은 `level%4≠0`에서 폐형과 발산** — 초기 "값 일치" 검산은 오류, §2 정정 참조), piety 재생 주석(595행 확정), PBLESS thaco 대입 후 감산(1021 무효 확정), 사망 시 down_level 미호출·레벨 클램프(creature.c 128–139 확정), 종족 효과 3종(->race 전 파일 grep으로 스탯보정·장비크기·암시야 외 없음 확증), 승급 L100 리셋·L127 초인 고정치(command7.c 606·618 확정).
- **곡선 예시 수치**(검사 L50=203hp/74mp 등)는 폐형 공식에 class_stats 값 대입 계산 — 정수 나눗셈 반영.
- **미확인/근사**: needed_exp의 레벨↔인덱스 정확 대응은 배열 주석이 불규칙해 "부근"으로 표기(임계값 자체는 배열 그대로 정확). profic/mprofic breakpoint 배열의 개별 중간값은 클래스 대표치만 인용(전 12칸×클래스 전부 재확인하지 않음). 스탯의 개별 기술 확률 기여(은신·도둑질 등)는 [[a2-command-catalog]] 범위로 위임.
- `command grep` 래퍼 `-I` EUC-KR skip 함정 재확인 — `command grep -a` 사용([[muhan-oracle-toolchain]]).
