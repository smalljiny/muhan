# A6 마법 시스템

> 무한의 마법(주문 카탈로그·시전 규칙·데미지 공식·지속효과 타이머·마법 자원)이 oracle에서 *무엇을 하는지*를 규명한다. 주문 효과·수치는 밸런스 정의이므로 충실히 이식하고, 디스패치(함수 포인터 테이블·`how==CAST` 4중 분기·lasttime 슬롯 재사용)는 형상이므로 자유롭게 재설계한다. 이슈 #6. 출처는 `legacy/muhan/src`(EUC-KR, byte-level)와 변환 산출물 `data/world/creatures.json`(몬스터 템플릿 674). 코드 이식이 아니라 동작 추출.
>
> **oracle 읽기 주의**: 하네스 `grep` 래퍼가 `-I`(binary skip)를 붙여 EUC-KR 파일을 스킵한다. `command grep -a` 또는 `iconv -f EUC-KR -t UTF-8 -c … | grep`로 우회한다([[muhan-oracle-toolchain]] 갱신 대상).

## 개요

무한의 마법은 **단일 주문 함수 집합을 네 개의 진입 경로가 공유**하는 구조다. 주문 하나는 `int fn(ply_ptr, cmnd, how)` 시그니처의 C 함수이고, `how`(CAST·POTION·SCROLL·WAND)만 다르게 넘겨 재사용한다. 시전자가 누구든(플레이어든 몬스터든) 같은 함수를 탄다 — 몬스터 마법조차 `crt_spell`이 `crt_ptr`을 `ply_ptr` 자리에 넣어 **동일한 주문 함수를 CAST 경로로 호출**한다.

주문은 `global.c`의 두 정적 테이블이 정본이다: **`spllist[]`**(55개 활성 주문 = 한글명·주문번호·함수포인터·전수등급)와 **`ospell[]`**(공격 주문 20개 = realm·마나·주사위). 명령 파서는 사용자가 친 한글 주문명을 `spllist`에서 선형 탐색(`strncmp` 접두 매칭)해 함수 포인터를 얻는다.

결정적 비대칭 하나: **마나·클래스·주문지식 게이트는 전부 `how == CAST` 조건에 감싸여 있다.** 즉 두루마리·물약·지팡이로 시전하면 이 게이트를 전부 우회한다 — 도력이 부족해도, 그 직업이 아니어도, 그 주문을 안 배웠어도 아이템만 있으면 발동한다. 대신 아이템 경로는 소모(두루마리 소멸·`shotscur--`)와 `spell_fail` 굴림으로 게이트된다. 이것이 "효과·수치는 콘텐츠(이식) / 디스패치는 형상(재설계)"의 핵심 접합점이다.

핵심 분리: **주문 효과·데미지 공식·게이트 의미·지속시간 공식·숙련 성장은 콘텐츠**(충실히 이식), **함수 포인터 선형 탐색·`how==CAST` 4중 반복·lasttime 슬롯 재사용·연산자 우선순위 버그·미완성 주문·dead 필드는 형상**(재설계).

## 핵심 발견 요약

| # | 발견 | 분류 |
|---|------|------|
| 1 | **주문 = `fn(ply, cmnd, how)` 단일 함수를 4경로가 공유.** cast(CAST)·read(SCROLL)·drink(POTION)·zap(WAND)가 같은 fn을 `how`만 바꿔 호출 | 콘텐츠(효과) / 형상(디스패치) |
| 2 | **마나·클래스·knowledge 게이트가 전부 `how==CAST` 조건부.** scroll/potion/wand는 게이트 우회, 대신 아이템 소모+spell_fail로 게이트 | 콘텐츠(규칙) |
| 3 | **주문 카탈로그 = `spllist[]` 55개 + `ospell[]` 20개.** 주문번호 0~56, 함수 포인터 테이블. 공격 20 = 4 realm × 5 tier | 콘텐츠(테이블) |
| 4 | **공격 데미지 `dice(ndice,sdice,pdice+bns)`.** bns = `bonus[int] + mprofic(realm)/{10,6,4}`(bonus_type별). tier1 1d8 ~ tier5 4d5+30 | 콘텐츠(공식) |
| 5 | **realm 상성 ×2/약화.** 방 플래그 RWATER/RFIRER/RWINDR/REARTH가 동속성 bns×2, 반대속성 bns를 음수(-5 cap). 물↔불, 바람↔땅 | 콘텐츠(공식) |
| 6 | **마법 저항 = `dmg -= dmg*2*MIN(50,piety+int)/100`.** PRMAGI/MRMAGI 보유 시. piety+int≥50이면 데미지 0(완전 무효) | 콘텐츠(공식) |
| 7 | **realm 숙련은 몬스터 대상 마법 데미지 비례 성장.** `realm[realm-1] += m*exp/hpmax`(A5 exp분배와 동형). mprofic이 읽어 데미지↑ 성장 루프. **PvP 마법은 성장 없음** | 콘텐츠(성장식) |
| 8 | **버프 지속 = `MAX(300, 1200+bonus[int]*600)`초**(CAST), 비-CAST 고정 1200. 클래스/RPMEXT 보너스. 예외: invis·levit은 MAX(300) 없음 | 콘텐츠(타이머) |
| 9 | **디버프 dur 개별 공식 + PRMAGI면 dur/2.** fear/silence/charm은 `LT_FEARS/SILNC/CHRMD`로 만료. **blind는 타이머 없음 = 개안 전까지 영구** | 콘텐츠(타이머) / 형상(blind dur 미사용) |
| 10 | **spell_fail = 클래스별 `chance=(L4+B)*배수+보정`, `mrand(1,100)>chance`면 실패.** MAGE+75 최고, BARBARIAN+0 최저. cap 없어 고레벨 사실상 무실패 | 콘텐츠(공식) |
| 11 | **주문 학습 = 비법서(SCROLL obj) 연마 `study` → `S_SET(magicpower-1)`.** 레벨 제한 obj->ndice. `teach`는 CARETAKER/MAGE/CLERIC이 전수(spllv 등급별 권한) | 콘텐츠(획득 규칙) |
| 12 | **마나 회복 = LT_HEALS 5초 틱 공용**(hp와 동일 슬롯). `mpcur += MAX(4, 5+(int>17)+메이지2)`. RPHARM·중독·질병 방해, RHEALR 방 +100·틱÷3 | 콘텐츠(자원) |
| 13 | **몬스터 마법 = 동일 주문 함수 재사용.** `crt_spell`이 spells[16] 비트에서 랜덤 선택, 치유는 자기·나머지는 공격자 대상. MMAGIC 플래그 + 확률(기본20%/MMAGIO면 prof[0]%). 674중 294가 주문 보유 | 콘텐츠(AI) / 형상(공유 함수) |
| 14 | **형상 버그 다수.** light 연산자우선순위로 600초 고정·magicrealm dead 필드·rm_blindness가 SRMDIS 슬롯 재사용·curse/rm_blindness 미완성·summon 51% 선굴림 클래스무관 mp차감 | 형상(비재현 후보) |

---

## 1. 디스패치 = 단일 함수 4경로 공유 (형상)

주문 함수의 시그니처는 `int fn(creature *ply_ptr, cmd *cmnd, int how[, ...])`. `how`는 진입 경로를 나타내는 상수다(`mtype.h`): `CAST=0`, `POTION=6`, `SCROLL=7`, `WAND=8`. 네 명령이 같은 함수 포인터 테이블을 탄다:

| 명령(함수) | how | 주문번호 소스 | 쿨다운 slot·초 | 소모 | 게이트 |
|---|---|---|---|---|---|
| `cast` (magic1.c:23) | CAST | `spllist` 한글명 접두 매칭 | LT_SPELL — CLERIC/MAGE/CARETAKER **3**, DM/SUB_DM **0**, 그외 **5** | 마나 | 마나·클래스·knowledge (각 fn 내부) |
| `read` (magic1.c:352) | SCROLL | `obj->magicpower-1` | LT_READS **3** | 두루마리 소멸(`free_obj`) | spell_fail, 오브젝트 정렬·클래스·레벨(ndice) |
| `drink` (magic1.c:496) | POTION | `obj->magicpower-1` | LT_SPELL **3** | 물약 `shotscur--` | spell_fail, POTION은 self 전용 |
| `zap`/`zap_obj` (magic1.c:673/776) | WAND | `obj->magicpower-1` | LT_SPELL **3** | 지팡이 `shotscur--` | spell_fail, `ODDICE`면 obj도 fn에 전달 |

**공통 진입 게이트**(모든 경로): `RNOMAG` 방이면 무효, `magicpower<1`이면 무효, `LT()` 쿨다운 대기(`please_wait`). cast는 추가로 `PBLIND`(눈멀면)·`PSILNC`(침묵이면) 거부.

`cast()`가 하는 일은 **얇은 디스패처뿐**이다 — 한글명을 `spllist`에서 선형 탐색(정확 일치 우선, 없으면 접두 매칭 개수 검사)해 함수 포인터 `fn`을 얻고, `offensive_spell`이면 `ospell[]`에서 해당 realm/주사위 레코드를 찾아 5인자로, 아니면 3인자로 호출한다. cast 본문에는 **마나 체크도, 레벨 체크도, 주문지식 체크도 없다** — 전부 개별 fn 안으로 밀려 있다.

각 fn 안의 게이트는 예외 없이 `how == CAST` 조건에 감싸인다. `vigor()`(magic2.c:35–47) 대표 사례:

```
if(ply_ptr->mpcur < 2   && how == CAST) { 도력 부족; return 0; }   // 마나
if(class != CLERIC && != PALADIN && < INVINCIBLE && how == CAST){…} // 클래스
if(!S_ISSET(ply_ptr, SVIGOR) && how == CAST) { 미터득; return 0; } // knowledge
```

→ **결론: 두루마리·물약·지팡이는 클래스·마나·주문지식을 전부 무시하고 발동**한다. 아이템 경로의 유일한 실패 요인은 진입부 `spell_fail` 굴림과 오브젝트 자체 제약(정렬 OGOODO/OEVILO, 클래스 OCLSEL, 레벨 ndice)이다.

> **#1 결정 포인트**: 신규 스택에서 주문을 (a) 원본대로 **단일 effect 함수 + how enum 4진입**으로 모델링할지, (b) effect(순수 함수)와 delivery(cast/scroll/potion/wand 어댑터)를 분리할지. 현 판단: 원본의 "how==CAST 게이트" 의미(아이템은 게이트 우회)는 **콘텐츠**이므로 보존하되, 4중 `how==CAST` 반복은 effect 함수를 `{gated: boolean}` 컨텍스트로 한 번만 받게 재설계한다.

---

## 2. 주문 카탈로그 = `spllist` + `ospell` (콘텐츠)

주문번호 상수는 `mtype.h:233–289`에 `SVIGOR=0` … `SCURSE=56`으로 정의(57개, `SNAHAN=56` 주석 처리). `spllist[]`(global.c:571–636)가 활성 55개의 정본이다. 원소는 `{ 한글명, 주문번호, 함수포인터, 전수등급(spllv) }`.

**주문 분류**(함수별):

| 계열 | 주문(함수) | 마나 | 대상 | 비고 |
|---|---|---|---|---|
| 치유 | vigor(회복)6→2·mend(원기회복)4·heal(완치)20·restore(도력반)·room_vigor(전회복)12 | 2~20 | self/타/몬스터/방 | heal=hpmax 완치, room_vigor=방 전체 |
| 해독·치료 | curepoison(해독)6·rm_disease(치료)12·rm_blind(개안)12·rm_blindness·remove_curse(저주해소)18 | 6~18 | self/타/몬스터 | 상태 플래그 F_CLR |
| 버프(자기강화) | bless(성현진)10·protection(수호진)10·invisibility(은둔법)15·levitate(부양술)10·fly(비상술)15·light(발광)5 | 5~15 | self/타 | §6 타이머 |
| 저항 버프 | resist_fire(방열진)12·resist_cold(방한진)12·resist_magic(보마진)12·breathe_water(수생술)12·earth_shield(지방호)12 | 12 | self/타 | 브레스·속성 방어 |
| 감지 | detectinvis(은둔감지)10·detectmagic(주문감지)10·know_alignment(선악감지)6 | 6~10 | self/타 | PDINVI/PDMAGI/PKNOWA |
| 이동·수송 | teleport(축지법)20·recall(귀환)30·summon(소환)50·magictrack(추적)13·object_send(전송)·room_vigor | 13~50 | self/전역플레이어 | [[a4-movement-rooms]] 연계 |
| 디버프 | befuddle(혼동)10·fear(공포)15·blind(실명)15·silence(봉합구)12·charm(이혼대법)15·curse(저주)25 | 10~25 | 몬스터/타 | §7 저항 |
| 대(對)언데드 | turn(방혼술)·absorb(흡성대법) | — | 몬스터(언데드) | how 없는 순수 CAST 명령 |
| 유틸 | enchant(빙의)25·drain_exp(백치술)·locate_player(천리안)15 | 15~25 | 아이템/전역 | enchant=아이템 강화 |
| 공격 | §4 offensive_spell 20종 | 3~25 | 몬스터/PvP | realm×tier |

**공격 주문 `ospell[]`**(global.c:637–659). 원소 `{ 주문번호, realm, mp, ndice, sdice, pdice, bonus_type }`. 4 realm(EARTH=1·WIND=2·FIRE=3·WATER=4) × 5 tier의 정연한 격자다:

| tier | mp | 주사위(ndice·sdice·pdice) | bonus_type | 기본 데미지 범위* | 예(WIND/EARTH/FIRE/WATER) |
|---|---|---|---|---|---|
| 1 | 3 | 1·8·0 (불만 1·7·1) | 1 (÷10) | 1~8 | 삭풍·지동술·화선도·탄수공 |
| 2 | 7 | 2·5·(7~8) | 2 (÷6) | 9~18 | 풍마현·폭진·화궁·파초식 |
| 3 | 10 | 2·5·13 | 2 (÷6) | 15~23 | 권풍술·낙석·화풍술·화룡대천 |
| 4 | 15 | 3·4·(18~19) | 3 (÷4) | 21~31 | 뇌전·토합술·주작현·열사천 |
| 5 | 25 | 4·5·30 | 3 (÷4) | 34~50 | 파천풍·지옥패·태양안·동설주 |

\* bns 제외 순수 주사위. `dice(n,s,p) = p + Σⁿ mrand(1,s)`([[a5-combat]]에서 확인된 공식). tier5 4종(동설주 SICEBL·파천풍 STHUND·지옥패 SEQUAK·태양안 SFLFIL)은 **MAGE 전용**(offensive_spell 내부 클래스 재검사, magic1.c self·대상 양쪽).

**레벨(주문 등급)에 관한 주의** — 이슈가 주문 속성으로 "레벨"을 나열했으나, 무한에는 **cast 시점의 레벨 게이트가 없다**. `spllist`의 `spllv` 필드는 오직 `teach`(전수) 권한 등급으로만 쓰이고(§8), 시전(cast)은 tier·레벨과 무관하게 마나·클래스·knowledge 게이트만 검사한다. "몇 레벨에 이 주문을 쓸 수 있는가"를 결정하는 실질 게이트는 **학습 단계**에 있다 — 비법서(SCROLL 오브젝트)의 `ndice` 필드가 연마(study)·읽기(read) 레벨 하한이다(§8). 따라서 위 카탈로그에 "요구 레벨" 컬럼이 없는 것은 누락이 아니라 설계 그대로다.

---

## 3. 시전 게이트와 spell_fail (콘텐츠)

**게이트 순서**(CAST, 각 fn 진입부): ① 마나 `mpcur < N` → ② 클래스 → ③ knowledge `!S_ISSET(ply, 주문번호)`. 세 게이트 모두 `&& how==CAST`. 클래스 게이트는 주문마다 다르다:

| 클래스 제한 | 주문 |
|---|---|
| 없음(knowledge만) | vigor·curepoison·light·bless·protection·mend·invisibility·detect*·teleport·befuddle·recall·summon·levitate·resist_*·fly·know_alignment·remove_curse·curse·breathe_water·earth_shield·locate_player·fear·charm |
| CLERIC·PALADIN(+INVINCIBLE↑) | vigor·heal·rm_blind·rm_blindness |
| CLERIC 전용(+INV↑) | rm_disease·room_vigor·recall |
| MAGE 전용(+INV↑) | enchant·object_send(추가 level≥20)·absorb·offensive tier5 4종 |
| RANGER 전용(+INV↑) | magictrack |
| SUB_DM↑ 관리자 전용 | blind·silence |
| DM 전용 | drain_exp |
| INVINCIBLE↑ CAST | restore(일반 클래스는 아이템 전용 주문) |

**spell_fail**(magic8.c:791–897) — 비주문 클래스(전사계)의 시전 실패 굴림. `n = mrand(1,100)`, `chance = (L4 + B)*배수 + 보정` (L4=`(level+3)/4` 실효레벨, B=`bonus[int]`), **`n > chance`면 실패(return 1)**:

| 클래스 | chance 공식 | 활성 |
|---|---|---|
| MAGE | `(L4+B)*5 + 75` | ✓ 최고 성공률 |
| CLERIC | `(L4+B)*5 + 65` | ✓ |
| RANGER | `(L4+B)*4 + 56` | ✓ 배수4 |
| PALADIN | `(L4+B)*5 + 50` | ✓ |
| ASSASSIN | `(L4+B)*5 + 30` | ✓ |
| THIEF | `(L4+B)*6 + 22` | ✓ 배수6 |
| FIGHTER | `(L4+B)*5 + 10` | ✓ |
| BARBARIAN | `(L4+B)*5 + 0` | ✓ 최저 |
| BARD·MONK | (주석 처리) | ✗ default로 낙하 |
| 그외/관리자 | `return 0` (무조건 성공) | ✓ |

`chance`에 상한이 없어 고레벨·고지능은 100을 초과 → 사실상 실패 불가. **주문 시전 자체는 실패 굴림이 이 함수에만 의존**하며, CLERIC/MAGE 같은 정규 캐스터는 애초에 spell_fail을 타지 않는다(개별 fn이 BARBARIAN/FIGHTER 등만 굴림 호출). 실패 시 CAST면 마나는 대부분 소모된다(주문별 차감 순서 상이 — §11).

---

## 4. 공격 데미지 공식 (콘텐츠)

`offensive_spell()`(magic1.c:820–1269)이 20개 공격 주문 전부의 단일 핸들러다. 데미지 계산 순서:

1. **게이트**: `mpcur < osp->mp && how==CAST`(마나), `!S_ISSET(ply, osp->splno) && how==CAST`(knowledge). 시전 시 `PINVIS` 해제(공격하면 은신 풀림).
2. **realm 보너스**(CAST 한정, bonus_type별): `bns = bonus[int] + mprofic(ply, osp->realm) / K`, `K = {1→10, 2→6, 3→4}`. **realm 숙련이 높을수록 데미지↑**.
3. **방 상성**: 방 플래그로 realm 보정 —

   | 방 플래그 | 강화(bns×2) | 약화(bns=`MIN(-bns,-5)`) |
   |---|---|---|
   | RWATER | WATER | FIRE |
   | RFIRER | FIRE | WATER |
   | RWINDR | WIND | EARTH |
   | REARTH | EARTH | WIND |

   물↔불, 바람↔땅이 상극. 반대 속성은 보너스가 음수로 뒤집혀 **데미지가 오히려 감소**.
4. **데미지**: `dmg = MAX(1, dice(osp->ndice, osp->sdice, osp->pdice + bns))`.
5. **마법 저항**(대상 PRMAGI/MRMAGI 보유 시): `dmg -= dmg * 2 * MIN(50, 대상 piety+int) / 100`. piety+int가 25면 50% 감소, **50 이상이면 100% 감소(완전 무효)**. resist_magic 버프를 켠 대상에게만 발동.
6. **적용**: `crt->hpcur -= dmg`, hp<1이면 `die()`([[a5-combat]] 사망 처리). `add_enm_crt`로 적대 등록.

**자기 대상 시전**(`cmnd->num==2`)도 가능 — 자해 데미지(테스트/자살 방지 `hpcur=1` 클램프). POTION 경로는 대상 지정 불가(self 전용, "독을 먹었다" 메시지로 자해).

PvP 게이트(대상이 플레이어)는 [[a5-combat]] §8과 **동일 구조**: RNOKIL 안전지대, 레벨 격차 약자 보호, 선악(비-PCHAOS 불가), 패거리 전쟁(`check_war`), RSUVIV 대련장 예외.

---

## 5. realm 숙련 성장 루프 (콘텐츠)

creature는 `realm[4]`(long, magic realm별 누적 경험치)를 가진다(mstruct.h:195). 공격 주문으로 **몬스터에게** 데미지를 주면(magic1.c:1128):

```
m = MIN(crt->hpcur, dmg);
addrealm = MIN( (m * crt->experience) / MAX(1, crt->hpmax), crt->experience );
if(crt->type != PLAYER) ply->realm[osp->realm-1] += addrealm;   // PvP는 성장 없음
```

이는 [[a5-combat]]의 근접 전투 exp 분배(`exp*기여데미지/hpmax`)와 **동형**이다 — 준 데미지 비율만큼 그 realm의 숙련 경험치를 얻는다. `mprofic()`(player.c:1204–1261)이 이 `realm[index-1]`을 **클래스별 임계 테이블 `prof_array[12]`**로 0~110 스케일 보간해 데미지 bns(§4-2)로 되먹인다:

- **MAGE가 가장 빠른 숙련**(prof_array 임계값 최저), CLERIC·PALADIN/RANGER 순, 전사계(default) 최고 임계값(가장 느림).
- 성장 루프: 공격 주문 시전 → realm[] 경험치↑ → mprofic↑ → 다음 시전 데미지↑. **realm별 독립 성장**(불 주문만 쓰면 FIRE realm만 는다).
- **PvP 마법은 realm 성장 없음**(`crt->type != PLAYER` 가드). 사망·숙련 손실은 command10.c:355(`realm[n-5] -= profloss/(9-n)`).

`magicrealm`(char, mstruct.h:129)은 구조체에 있으나 **코드 사용처 0 = dead 필드**([[a5-combat]]의 dead 플래그 부류).

---

## 6. 지속효과 타이머 (콘텐츠) — 핵심 산출

버프는 `lasttime[LT_slot]`에 `ltime=현재시각`, `interval=지속초`를 기록한다. 만료 판정은 각 소비처에서 `time(0) > ltime + interval`. **표준 버프 지속 공식**(CAST): `interval = MAX(300, 1200 + bonus[int]*600)` + 클래스/RPMEXT 보너스. 비-CAST(scroll/wand/potion)는 **고정 1200초**.

| 주문 | LT slot | CAST interval | 클래스 보너스 | RPMEXT | 비-CAST |
|---|---|---|---|---|---|
| protection | LT_PROTE (1) | MAX(300, 1200+B*600) | CLERIC/PALADIN `+60*L4` | +800 | 1200 |
| bless | LT_BLESS (2) | 〃 | CLERIC/PALADIN `+60*L4` | +800 | 1200 |
| resist_fire | LT_RFIRE (23) | 〃 | — | +800 | 1200 |
| resist_cold | LT_RCOLD (29) | 〃 | — | +800 | 1200 |
| resist_magic | LT_RMAGI (25) | 〃 | — | +800 | 1200 |
| breathe_water | LT_BRWAT (30) | 〃 | — | +800 | 1200 |
| earth_shield | LT_SSHLD (31) | 〃 | — | +800 | 1200 |
| know_alignment | LT_KNOWA (27) | 〃 | — | +800 | 1200 |
| detectinvis | LT_DINVI (17) | 〃 | MAGE `+60*L4` | +600 | 1200 |
| detectmagic | LT_DMAGI (18) | 〃 | MAGE `+60*L4` | +600 | 1200 |
| fly | LT_FLYSP (24) | 〃 | — | +600 | 1200 |
| invisibility | LT_INVIS (0) | `1200 + B*600` **(MAX 없음)** | MAGE `+60*L4` | +600 | 1200 |
| levitate | LT_LEVIT (21) | `2400 + B*600` **(MAX 없음)** | — | +800 | 1200 |
| light | LT_LIGHT (13) | **버그로 600 고정**(§11) | — | (+600) | — |

B=`bonus[int]`, L4=`(level+3)/4`. `MAX(300,…)` 하한은 지능 페널티(bonus 음수)로 지속이 음수가 되는 것을 막는데, **invisibility·levitate만 이 하한이 빠져 있다** — 저지능이면 지속이 극단적으로 짧아질 수 있다(형상 결함 후보).

**즉발(타이머 없음)**: curepoison·mend·heal·restore·room_vigor·rm_disease·rm_blind·rm_blindness·remove_curse·curse·teleport·recall·summon·magictrack·object_send·enchant·drain_exp·know_alignment(감지는 KNOWA 타이머). curse는 아이템 `OCURSE` 영구 플래그를 설정(대상이 장비를 못 벗음)하므로 타이머가 아닌 **상태 영속**이다.

---

## 7. 디버프와 저항 (콘텐츠)

디버프는 표준 버프 공식과 달리 **주문별 dur 공식**을 쓰고, 대상의 마법저항(PRMAGI/MRMAGI)이 **지속을 절반**으로 깎는다(무효화가 아님):

| 주문(효과 플래그) | LT slot | dur (CAST) | dur (SCROLL) | dur (WAND) | 저항·면역 |
|---|---|---|---|---|---|
| fear (PFEARS/MFEARS) | LT_FEARS (33) | `600 + mrand(1,30)*10 + B*150` | `600 + mrand(1,15)*10 + B*50` | `600 + mrand(1,30)*10` | PRMAGI→dur/2, **MPERMT 완전면역** |
| silence (PSILNC/MSILNC) | LT_SILNC (34) | **3600 고정** | `300 + mrand(1,15)*10 + B*75` | `300 + mrand(1,15)*10` | PRMAGI→dur/2 |
| charm (PCHARM/MCHARM) | LT_CHRMD (36) | `300 + mrand(1,30)*10 + B*30` | `100 + mrand(1,15)*10 + B*30` | `100 + mrand(1,15)*10` | PRMAGI→dur/2, **시전자 lvl<대상 lvl 또는 MNOCHA면 완전 반탄**, RSUVIV 방 금지 |
| befuddle 타(MBEFUD) | LT_BEFUD (40) | `B + dice(2,6,0)` | — | `dice(2,5,0)` | PRMAGI/MRMAGI/MRBEFD면 dur=3(단축) |
| befuddle self | LT_ATTCK (3) | `B*2 + dice(2,6,0) + MAGE L4/2`, MAX(6) | — | — | (자기 스턴) |
| blind (PBLIND/MBLIND) | **없음** | — | — | — | MUNKIL 몬스터 시전 불가 |

- **효과 의미**: fear=도주율↑+공격−2, silence=주문·발화·yell 불가, charm=시전자 공격 불가+아군화(`add_charm_crt`), befuddle=행동 불가(추가로 `LT_SPELL`·PLAYER면 `LT_ATTCK`도 `MIN(9,dur)`로 봉쇄).
- **blind의 결함**: `dur` 변수가 선언되나 미사용 — 타이머를 안 걸어 **개안술(rm_blind)로 명시 해제하기 전까지 영구 실명**. 콘텐츠(영구 지속)로 볼지 형상 버그로 볼지 결정 필요.
- **대(對)언데드**(turn/absorb): `how` 없는 순수 CAST 명령. turn(CLERIC/PALADIN)=명중 `chance=(L4−대상L4)*20 + piety*5 + {PALADIN15/기타25}`, `MIN(80)`; 성공 시 `90−piety` 초과 굴림이면 즉사, 아니면 hp 절반. absorb(MAGE)=hp 흡수(`dmg=(level+73)/4*10`), 언데드면 흡수 실패+시전자 mp 전소. 둘 다 `LT_TURNS` 30초 쿨다운.

---

## 8. 학습·전수 (콘텐츠)

**주문 지식 = `spells[16]` 비트마스크**(mstruct.h:196, 128비트=최대 128주문). `S_ISSET(p,f) = spells[f/8] & 1<<(f%8)`(mtype.h:570). 획득 두 경로:

- **study(연마)**(magic1.c:259): 비법서(type==SCROLL 오브젝트)를 연마 → `S_SET(ply, obj->magicpower-1)`로 주문 비트 영구 획득, 비법서 소멸. 게이트: PBLIND 거부, `obj->ndice > level`이면 레벨 부족, 정렬(OGOODO/OEVILO), 클래스(OCLSEL + class 비트). **같은 SCROLL 오브젝트가 `study`(영구 학습)와 `read`(1회 시전) 두 용도** — ndice=레벨제한, magicpower=주문번호로 공유.
- **teach(전수)**(magic1.c:125): CARETAKER/MAGE/CLERIC이 방의 다른 플레이어에게 `S_SET(대상, 주문번호)`. 시전자가 그 주문을 알아야(S_ISSET). **`spllist`의 `spllv`(전수등급)가 여기서만 쓰인다** — spllv 1(CLERIC↑)·2(MAGE↑)·3(INVINCIBLE↑)·4(CARETAKER↑)·5(SUB_DM↑)만 전수 가능. cast에는 spllv가 관여하지 않는다(레벨 게이트는 study의 obj->ndice가 담당).

---

## 9. 마나 자원 (콘텐츠)

`mpmax`/`mpcur`(short, mstruct.h:184–185). **회복은 hp와 동일한 LT_HEALS(8) 슬롯 5초 틱**(player.c:585):

```
mpcur += MAX(4, 5 + (intelligence>17 ? 1:0) + (class==MAGE ? 2:0));
lasttime[LT_HEALS].interval = 5;                       // 5초 주기
// RPHARM 방·PPOISN·PDISEA면 회복 정지
// RHEALR 방: mpcur += 100, interval /= 3 (빠른 회복)
// mpcur = MIN(mpcur, mpmax) 클램프
```

지능>17이면 +1, MAGE면 +2 — 지능·직업이 마나 회복 속도를 결정. 소비는 주문별 고정값(§2 표)이며 각 fn 내부 `mpcur -= N`(CAST 한정). **몬스터 마나 회복은 별도**: update_active 틱에서 `mpcur += MAX(1, mpmax/6)`(update.c:270, [[a5-combat]] §1 자가회복).

---

## 10. 몬스터 마법 = 공유 함수 재사용 (콘텐츠+형상)

몬스터도 주문을 쓴다. `data/world/creatures.json` 674 템플릿 중 **294가 주문 비트(spells) 보유, 286이 mpmax>0**(예: 사당귀신 mp50·lvl60, 야바단의 유령 mp15·lvl60, 그림자 mp12·lvl36).

`crt_spell(crt_ptr, att_ptr)`(update.c:654)가 몬스터 시전을 담당하며, **플레이어와 완전히 동일한 주문 함수를 CAST 경로로 호출**한다(`crt_ptr`을 `ply_ptr` 자리에):

1. `spells[16]` 비트를 훑어 아는 주문 최대 10개 수집.
2. `mrand(1, knowctr)`로 랜덤 선택(하나도 없으면 spl=1=삭풍).
3. 치유 주문(SVIGOR/SMENDW/SFHEAL)이면 자기 대상(num=2), 아니면 공격자 대상(num=3).
4. `offensive_spell`이면 `ospell[]` 조회 후 CAST로, 아니면 CAST로 호출.

**시전 조건**(update.c:352, 몬스터 공격 틱 내부): `MMAGIC` 플래그 보유 + `mrand(1,100) <= n`(n=기본 20, MMAGIO 플래그면 `proficiency[0]`%) + 매혹 주인 공격이 아닐 것(`!p`). 즉 마법 몬스터는 매 공격 기회마다 확률적으로 근접 대신 주문을 쏜다.

→ **형상 함의**: 몬스터·플레이어가 같은 effect 함수를 공유하는 것은 재사용 관점에서 좋으나, 함수가 `creature*`를 "시전자"로 받아 클래스·mprofic·realm 등 플레이어 필드를 몬스터에도 적용한다. 신규 스택에서 caster 추상(플레이어/몬스터 공통 인터페이스)을 세우면 자연스럽게 재현된다.

---

## 11. 형상·버그 목록 (재설계 / 비재현 후보)

| # | 항목 | 성격 | 처리 |
|---|---|---|---|
| a | **light interval 연산자 우선순위 버그**: `300+L4*300 + (RPMEXT)?600:0`이 `(합계)?600:0`으로 파싱 → 항상 600초 고정, 레벨 스케일 무효 | 버그 | 비재현(의도된 스케일 공식으로 복원) |
| b | **invisibility·levitate에 `MAX(300)` 하한 없음** — 저지능이면 지속 음수/극단 단축 | 결함 | 표준 버프처럼 하한 적용 검토 |
| c | **magicrealm 필드 dead** (사용처 0) | dead | 제외 |
| d | **rm_blindness가 SRMDIS 슬롯 재사용**(rm_disease와 knowledge 비트 공유), 메시지 영문 placeholder, rm_blind와 기능 중복 | 미완성 | rm_blind로 통합, rm_blindness 제외 |
| e | **curse 메시지 다수 placeholder** | 미완성 | 효과(OCURSE 설정)만 이식 |
| f | **blind 타이머 미설정**(dur 선언·미사용) → 영구 실명 | 결함/의도 모호 | 타이머 부여 여부 결정 |
| g | **summon 51% 선(先)실패 굴림에서 클래스 무관 `mpcur -= 50` 차감**(INVINCIBLE은 본 소비 100인데 실패 페널티는 50) | 불일치 | 일관된 소비로 재설계 |
| h | **mend self/타 분기 CLERIC 보너스 조건 불일치**(self는 `>=INVINCIBLE` 포함, 타는 미포함) | 불일치 | 통일 |
| i | **함수 포인터 배열 + strncmp 선형 탐색**, `how==CAST` 4중 반복, lasttime 슬롯 수동 관리(LT_TRACK=LT_MSCAV=4 등 중복) | 구조 | effect/delivery 분리·enum·타이머 추상으로 재설계 |
| j | **absorb hpmax 클램프 주석 처리** → hp 초과 회복 가능 | 버그 | 클램프 복원 검토 |

---

## 12. 아키텍처 함의

1. **effect/delivery 분리.** 원본의 단일 `fn(caster, cmnd, how)`는 효과와 전달 경로가 한 함수에 얽혀 있다. 신규 스택은 **순수 효과 함수**(`applyVigor(caster, target, ctx)`)와 **delivery 어댑터**(cast/scroll/potion/wand — 각자 소모·쿨다운·spell_fail·게이트-우회 여부를 결정)로 분리한다. `how==CAST` 게이트 의미는 `ctx.gated` 한 플래그로 흡수한다.

2. **주문 데이터는 선언적 테이블로.** `spllist`/`ospell`의 realm·mp·주사위·전수등급·타이머 공식은 코드가 아니라 **데이터**(JSON/config)여야 한다. offensive 20종은 `{realm, tier}`에서 파생 가능한 격자이므로 생성 규칙으로 압축 가능.

3. **타이머는 스케줄러로.** lasttime 슬롯 수동 관리(만료를 소비처마다 `time(0)>ltime+interval`로 검사)는 [[muhan-mud-port]]의 JS 스케줄러/EventEmitter로 대체한다. 버프 만료를 이벤트로 발행하면 §6·§7 표가 그대로 지속시간 데이터가 된다.

4. **caster 공통 인터페이스.** 몬스터·플레이어가 같은 효과 함수를 공유(§10)하므로, `Caster`(mpcur·realm·class·bonus 접근)를 인터페이스로 세우면 crt_spell/cast 양쪽이 자연 재현된다.

5. **realm 숙련 성장은 전투 성장과 통합.** §5 addrealm 공식이 [[a5-combat]] exp 분배와 동형이므로, "데미지 기여 → 성장" 로직을 realm·무기 숙련·exp에 공통 적용하는 단일 성장 파이프로 묶는다.

6. **콘텐츠/형상 경계 확정.** 이식: §2 카탈로그·§3 게이트·§4 데미지·§5 성장·§6·§7 타이머·§8 학습·§9 마나·§10 몬스터 AI 확률. 재설계/비재현: §11 전 항목(버그·미완성·dead·구조).

---

## 검증 메모

- **직접 읽어 확인**(byte-level): `cast`·`offensive_spell`·`readscroll`·`drink`·`zap_obj`·`study`·`teach`·`crt_spell`·`mprofic`·mp회복 틱, 그리고 §의 핵심 주장 spot-check — `light` 우선순위 버그(magic2.c:316–317, `합계 + (F_ISSET)?600:0`으로 항상 600 고정 확정), `protection`/`bless` 타이머 `MAX(300,1200+B*600)`+클래스 보너스, `invisibility` 타이머 `1200+B*600`(MAX 하한 없음 확정, bless와 대조), `blind` 타이머 미설정(dur 선언·미사용 확정), `spell_fail` 클래스별 chance(ASSASSIN+30·BARBARIAN+0·CLERIC+65·FIGHTER+10·MAGE+75, BARD/MONK 주석, `n>chance`면 실패).
- **magic2~8 개별 주문의 나머지 세부**(마나값·대상·메시지 분기)는 보조 추출로 수집 후 위 대표 사례로 패턴 검증했다 — 전 함수를 라인 단위로 재확인하지는 않았으므로, 개별 마나값·라인 번호에 미세 오차 가능성이 있다.
- 몬스터 caster 통계(294/674, 286 mp>0)는 `data/world/creatures.json` 집계.
- `dice(n,s,p)=p+Σⁿmrand(1,s)` 공식은 [[a5-combat]]에서 바이트 검증 완료.
- `command grep` 래퍼의 `-I` 플래그가 EUC-KR을 binary skip하는 함정 재확인 — `command grep -a` 필수([[muhan-oracle-toolchain]]에 추가).
