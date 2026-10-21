# A8 아이템·장비·경제·은행

> 무한에서 다음 세 영역이 oracle에서 *무엇을 하는지*를 정리한다.
> - 아이템 체계: 타입 taxonomy, 착용/장비 규칙, object 필드
> - 경제: 금화, 가치, 상점, 전당포, 수리, 거래
> - 은행
>
> 아이템 속성, 가격 배수, 착용 게이트, 거래 규칙은 게임 규칙이므로 충실히 이식한다. 반면 다음은 원작의 구현 방식이므로 자유롭게 재설계한다: 은행을 별도 object 파일 컨테이너로 두는 구조, 직렬화되지 않는 `ready[]` 포인터 배열, 상점 재고를 인접방에 두는 규약, 가드 없는 gold signed long. 이슈 #8. 출처는 `legacy/muhan/src`(EUC-KR, byte-level)와 변환 산출물 `data/world/objects.json`이며, 코드를 이식하지 않고 동작만 추출한다.
>
> **oracle 읽기 주의**: 하네스의 `grep` 래퍼가 `-I`(binary skip)를 붙이기 때문에 EUC-KR 파일을 건너뛴다. `command grep -a` 또는 `iconv -f EUC-KR -t UTF-8 -c … | grep`로 우회한다([[muhan-oracle-toolchain]]).
>
> **전투·마법·진행 공식은 다시 유도하지 않는다**: 무기 데미지·명중·숙련은 [[a5-combat]], 물약/두루마기/지팡이의 주문 시전은 [[a6-magic]], AC/thaco 닫힌 식과 스탯 보정은 [[a7-player-progression]]에서 이미 확정했다. 이 노트는 그 공식들에 **아이템이 기여하는 항**(장비 armor 합산, 무기 adjustment 명중 보정)만 더한다.

## 개요

무한의 아이템은 모두 **`object` 구조체 하나**(352바이트)로 표현된다. 방, 몬스터, 플레이어 인벤토리, 은행이 모두 같은 구조체를 담고, 같은 직렬화(`read_obj`/`write_obj`)를 쓴다([[a4-movement-rooms]]). 아이템의 성격은 **`type` 필드(0~14)** 하나로 결정된다.
- 무기 5종(0~4)
- 방어구, 물약, 두루마기, 지팡이, 컨테이너, 돈, 열쇠, 광원, 기타(5~13)
- help에는 없는 CONTAINER2(14)

아이템의 게임 동작은 세 가지로 나뉜다.
- ① **착용/장비**: 방어구는 `wear`, 무기는 `ready`, 쥠물건은 `hold`가 처리한다. 각 명령은 `creature.ready[20]` 슬롯 배열의 정해진 칸에 포인터를 넣는다. 착용 효과(AC·명중)는 필드를 직접 더하거나 빼지 않고, **매번 `ready[]` 전체로 다시 계산**한다(`compute_ac`/`compute_thaco`). 이는 [[a7-player-progression]] §12의 "파생 스탯은 유효 상태의 함수" 원칙과 정확히 같다.
- ② **소비**: 물약/지팡이는 쓸 때마다 `shotscur--`로 충전이 줄고, 다 쓰면 부서진다.
- ③ **경제**: `object.value`(long) 하나가 모든 가격의 기준이다. 상점 구매(100%), 전당포 판매(50%), 수리(25%), 몬스터 상점(max(10,value))은 이 값에 상수 배수를 곱해 정한다.

착용하려면 **여러 단계의 게이트**를 통과해야 한다. 클래스, 성별, 결혼, 성향, 종족 크기 제한이 있고, **아이템 강도에 비례한 레벨 요구**도 있다(방어구 `armor*5`, 무기 `(ndice·sdice+pdice)*3`). 기준을 넘는 초강력 아이템(방어구 AC환산 >151, 무기 dice합 >39)은 착용하려 하면 **"푸른 연기와 함께 사라진다"**. 밸런스를 벗어난 아이템을 자동으로 없애는 방어 장치다.

은행은 구조가 특이하다. 잔고는 `creature` 필드가 아니라 플레이어별 **별도 object 파일**(`PLAYERPATH/bank/<이름>`)에 있다. 그 object가 컨테이너로 동작해, 현금은 `value`에, 보관 물품은 중첩 인벤토리에 담는다. 이자는 없다(단순 금고). 신규 스택의 계좌 모델(MongoDB 문서)은 이 "은행=object 파일" 구조를 어떻게 바꿀지에 따라 달라진다.

핵심 분리:
- **콘텐츠(충실히 이식):** 타입 taxonomy, 착용 슬롯, 레벨/직업/성별/크기 게이트, 가격 배수(100/50/25%), 소지 한도(150/200), 몹 소지금 랜덤화, 거래 거부 조건.
- **구현 방식(재설계):** 은행=별도 object 파일 컨테이너, `ready[]` 포인터 배열, 상점 재고=`rom_num+1` 인접방, 가드 없는 gold signed long, time(0) 기반 확률, 데드 statement.

## 핵심 발견 요약

| # | 발견 | 분류 |
|---|------|------|
| 1 | **아이템 = `object` 352B 단일 구조체.** type 0~14로 성격 결정. 무기 0~4(Sharp/Thrust/Blunt/Pole/Missile), 5~13(Armor·Potion·Scroll·Wand·Container·Money·Key·LightSource·Misc), 14(Container2, help 미기재) | 콘텐츠(taxonomy) |
| 2 | **착용 = `ready[20]` 슬롯 배열.** wearflag(1~20)이 슬롯 인덱스(`ready[wearflag-1]`). BODY·팔·다리·목×2·손·머리·발·손가락×8·쥠·방패·얼굴·무기. 방어구=`wear`, 무기=`ready`, 쥠=`hold` | 콘텐츠(장비) |
| 3 | **착용 효과는 필드 직접변형 아님 — `ready[]` 재계산.** `compute_ac`=`… − Σ ready[i]->armor …`, `compute_thaco`=`… − ready[WIELD]->adjustment …`. wear/ready/remove가 재계산 트리거. [[a7-player-progression]] §12 원칙과 일치 | 이식(공식)/재설계(트리거) |
| 4 | **착용 다층 게이트.** 클래스(ONOMAG·OCLSEL)·성별(ONOFEM=남/ONOMAL=여, 명명 역전)·결혼(OMARRI)·성향(OGOODO/OEVILO ±50)·종족크기(OSIZE 3계급)·**레벨(방어구 armor*5, BODY armor*2 / 무기 dice합*3)** | 콘텐츠(규칙) |
| 5 | **밸런스 초과 아이템 자동 소각.** 착용 시 방어구 AC환산 >151, 무기 `ndice·sdice+pdice` >39, shots >600 → questnum·ONEWEV 아니면 free("푸른 연기와 함께 사라집니다") | 콘텐츠(가드) |
| 6 | **소비 아이템 = `magicpower-1` 스펠 시전.** Potion=`drink`, Scroll=`readscroll`, Wand=`zap` → `shotscur--` → [[a6-magic]] spllist[magicpower-1]를 각 컨텍스트로 시전. 무기 데미지는 [[a5-combat]] | 콘텐츠(→a6/a5) |
| 7 | **가격 = `object.value` 단일 필드 × 상수 배수.** 상점구매=value(1:1), 전당포판매=min(value/2, 10만), 수리=value/4, 몹구매=max(10, value) | 콘텐츠(경제) |
| 8 | **상점 재고 = 인접방 `rom_num+1` object를 복제, 무소진.** buy는 창고방에서 로드→복제 지급. 몹 상점(MPURIT)은 `carry[]` objnum 템플릿 복제(무한 재고) | 이식(규칙)/재설계(방 규약) |
| 9 | **금화 = `creature.gold`(long, offset 348) 무가드.** 몹 처치 시 `die()`가 gold를 바닥의 MONEY object로 변환. 몹 소지금은 스폰 시 `mrand(gold/10, gold)` 랜덤(MNRGLD면 고정) | 이식(드롭)/재설계(무가드) |
| 10 | **상점/서비스 방 = room flag.** RSHOPP=0(상점)·RPAWNS=2(전당포)·RREPAI=7(수리)·RDUMPR=1(덤프)·RBANK=39(은행)·RMARRI=41(결혼) | 이식(게이트)/재설계(비트) |
| 11 | **은행 = 별도 object 파일 컨테이너.** `bank/<이름>` 파일, 현금=`object.value`, 물품=중첩 인벤토리(슬롯 200). 입금/출금/잔액/보관물/받아. **이자 없음, 3억 상한, 수수료·이체 없음** | 재설계(영속화) |
| 12 | **거래 다중 거부.** 판매: gold<20·저품질(shots≤max/8)·ONEWEV·컨테이너내용·두루마기/물약. 양도: questnum·ONEWEV·이벤트. 습득: ONOTAK·OSCENE·MGUARD 감시 | 콘텐츠(규칙) |
| 13 | **소지 한도 = 무게 + 개수(150/200).** get/give/purchase=150, buy=200(장착 포함 count_inv). 무게는 `max_weight(ply)`([[a7-player-progression]]) 초과 시 거부 | 콘텐츠(한도) |

---

## 1. object 구조체와 타입 taxonomy (콘텐츠)

아이템은 **352바이트 `object` 구조체**다(`mstruct.h:112–135`). 검증된 오프셋 테이블은 `port/templates.js`의 `OBJ`에 있다([[muhan-mud-port]]). 이 노트가 참조하는 필드는 다음과 같다.

| 필드 | 오프셋 | 자료형 | 의미 |
|---|---|---|---|
| `name` | 0 | char[80] | 이름(EUC-KR) |
| `description` | 80 | char[80] | 설명 |
| `key[3][20]` | 160 | char | 인식 키워드 3개(key[2]는 ONEWEV 소유자명으로 오버로드) |
| `use_output` | 220 | char[80] | 착용/장착 시 출력 |
| `value` | 300 | long | **가치/가격**(§7·8) |
| `weight` | 304 | short | 무게 |
| `type` | 306 | char | **타입 0~14** |
| `adjustment` | 307 | char | 무기 명중+피해 보정(+N) |
| `shotsmax/shotscur` | 308/310 | short | 사용/내구 횟수 |
| `ndice/sdice/pdice` | 312/314/316 | short | 데미지 주사위([[a5-combat]]) |
| `armor` | 318 | char | **AC 기여**(§3) |
| `wearflag` | 319 | char | **착용 슬롯 1~20**(§2) |
| `magicpower` | 320 | char | 소비 시 시전할 스펠 번호+1([[a6-magic]]) |
| `magicrealm` | 321 | char | 마법 계열 |
| `special` | 322 | short | 특수 동작 파라미터 |
| `flags[8]` | 324 | char | **비트필드**(§6) |
| `questnum` | 332 | char | 임무 번호(대부분의 파괴/게이트를 우회) |
| `first_obj` | 336 | ptr | 중첩 인벤토리(컨테이너) |

### 타입 상수 (`mtype.h:123–139`)

| type | 상수 | 게임 동작 |
|---|---|---|
| 0 | SHARP | 무기(검류). type ≤ MISSILE(4)이 "무기" 판정 관용구 |
| 1 | THRUST | 무기(찌르기) |
| 2 | BLUNT | 무기(둔기) |
| 3 | POLE | 무기(장병기) |
| 4 | MISSILE | 무기(투척/원거리) |
| 5 | ARMOR | 방어구. `armor` 필드가 AC 기여 |
| 6 | POTION | 물약. `drink`로 소비 → 스펠 시전 |
| 7 | SCROLL | 두루마기. `readscroll`로 시전 + `study`로 학습 |
| 8 | WAND | 지팡이. `zap`으로 시전 |
| 9 | CONTAINER | 컨테이너. 담기/꺼내기(OCONTN) |
| 10 | MONEY | 돈. 줍기 시 gold로 흡수 |
| 11 | KEY | 열쇠. shotscur = 사용 횟수 |
| 12 | LIGHTSOURCE | 광원(OLIGHT) |
| 13 | MISC | 기타. 특수 동작 없음 |
| 14 | CONTAINER2 | `mtype.h:132`에 정의되나 `help/otypes`엔 없음. 2차 컨테이너 변형(월드 데이터 실사용 여부 미확인 — 변환 시 별도 확인 필요) |

> **타입 열거 주의**: `help/otypes`는 0~13만 문서화하지만, 헤더는 `CONTAINER2=14`를 추가로 정의한다. 이식할 때 타입 범위는 **0~14**로 잡고, 14가 실제로 쓰이는지는 `data/world/objects.json`에서 개수를 세어 확정한다.

무기군(0~4)에는 **type별 물리 데미지 배수가 없다**. type은 **proficiency(무기 숙련)를 계산하는 키**로만 쓰인다(`command5.c:240` `mod_profic`, [[a5-combat]]). 즉 검, 둔기, 장병기의 차이는 데미지 공식이 아니라 숙련 성장과 명중에서 생긴다.

---

## 2. 착용 슬롯과 `wear()` 게이트 (콘텐츠)

플레이어는 **`ready[MAXWEAR]` 포인터 배열**에 착용 아이템을 넣는다(`mstruct.h:204` `struct object *ready[MAXWEAR]`, `MAXWEAR=20`). `wearflag`(1~20)가 슬롯 인덱스이고, 슬롯은 `ready[wearflag-1]`이다.

### 슬롯 매핑 (`mtype.h:206–230`)

| wearflag | 슬롯 | 부위 | 처리 명령 |
|---|---|---|---|
| 1 | BODY | 몸 | wear |
| 2 | ARMS | 팔 | wear |
| 3 | LEGS | 다리 | wear |
| 4 / 5 | NECK1 / NECK2 | 목(2칸) | wear |
| 6 | HANDS | 손 | wear |
| 7 | HEAD | 머리 | wear |
| 8 | FEET | 발 | wear |
| 9–16 | FINGER1–8 | 손가락(8칸) | wear |
| 17 | HELD | 쥔 물건 | hold |
| 18 | SHIELD | 방패 | wear |
| 19 | FACE | 얼굴 | wear |
| 20 | WIELD | 무기 | ready |

목은 2칸, 손가락은 8칸, 나머지는 1칸이다. `wearflag==WIELD`(무기)나 `HELD`(쥠)는 `wear`가 거부하며, 각각 `ready`·`hold`로 처리해야 한다.

### `wear()` 게이트 순서 (`command3.c:21`)

```c
if(!obj_ptr->wearflag || obj_ptr->wearflag == WIELD || obj_ptr->wearflag == HELD) {
    print(fd, "%I%j 입는 물건이 아닙니다."); return(0);      // 무기·쥠물건은 여기서 컷
}
```

그다음 아래 항목을 순서대로 검사한다. 모두 통과해야 착용할 수 있다.

1. **직업**: ARMOR + `ONOMAG` + (MAGE 또는 CLERIC) → 거부("도술사, 불제자들은 사용할수 없습니다").
2. **성별**: `ONOFEM` + 여성 → 거부("남자들만"), `ONOMAL` + 남성 → 거부("여자들만"). **플래그 이름이 직관과 반대**다(ONOFEM="Usable by only males").
3. **내구 소각**: `shotsmax > 1001 || shotscur > 1001` + questnum==0 → free.
4. **레벨 게이트**(`command3.c:88`):
   ```c
   if(obj_ptr->wearflag == BODY) check_ac = obj_ptr->armor * 2;
   else                          check_ac = obj_ptr->armor * 5;
   if(check_ac > 151 && obj_ptr->questnum == 0) { free; "푸른 연기와 함께 사라집니다"; }
   if(check_ac < 30) check_ac = 0;
   if(ply_ptr->class < INVINCIBLE && questnum==0 && !ONEWEV && ply_ptr->level < check_ac)
       "당신의 능력으로는 사용할 수 없는 물건입니다.";
   ```
   방어구 강도(`armor`)에 비례해 레벨을 요구한다. BODY는 배수가 2로 더 낮다. 몸통 방어구는 armor가 크기 때문에 완화한 것이다. AC환산 30 미만이면 요구 레벨은 0이다.
5. **결혼**: ARMOR + `OMARRI` + 미혼(PMARRI 없음) → 거부.
6. **슬롯 점유**:
   - NECK1·NECK2가 모두 차 있으면 "더이상 목에 걸 수 없습니다".
   - FINGER1~8이 모두 차 있으면 "더이상 손가락에 낄 수 없습니다".
   - 그 외 부위는 `ready[wearflag-1]`이 이미 있으면 "이미 착용 중".
7. **파손**: `shotscur < 1` → "부서져서 입을 수 없게 되었습니다".
8. **성향**: `OGOODO` + alignment < −50이면 튕겨 낸다(바닥으로). `OEVILO` + alignment > 50이어도 튕겨 낸다.
9. **직업 선택 무기/방어구**: `OCLSEL`이 설정돼 있으면 `OCLSEL + class` 비트가 켜져 있어야 착용할 수 있다(§6).
10. **종족 크기**(§6): `OSIZE1·OSIZE2` 조합이 종족과 맞지 않으면 거부.

통과하면 슬롯을 설정하고(`command3.c:195`) → `compute_ac(ply_ptr)`로 다시 계산한 뒤 → `F_SET(OWEARS)`를 켠다.

```c
switch(obj_ptr->wearflag) {
case BODY: case ARMS: ... case SHIELD:
    ply_ptr->ready[obj_ptr->wearflag-1] = obj_ptr; break;    // 단일 부위
case NECK:
    if(ready[NECK1-1]) ready[NECK2-1]=obj; else ready[NECK1-1]=obj; break;
case FINGER:
    for(i=FINGER1; i<FINGER8+1; i++) if(!ready[i-1]){ ready[i-1]=obj; break; } break;
}
compute_ac(ply_ptr);
```

`wear_all`(`command3.c:287`)은 인벤토리를 순회하며 같은 게이트를 반복한다(임계 `>150` 등도 같다). `remove`/`remove_all`(`command3.c:564`)은 `OCURSE`(저주) 아이템을 건너뛴다(`command3.c:574`). 벗긴 뒤에는 `compute_ac`+`compute_thaco`를 다시 계산하고 `F_CLR(OWEARS)`·`F_CLR(OWHELD)`를 적용한다.

---

## 3. 무기 장착 `ready()`·쥠 `hold()` (콘텐츠)

무기 슬롯은 **WIELD 하나뿐**이다. 양손/한손 구분 없이 한 자루만 장착한다. `ready()`(`command3.c:691`)는 다음을 검사한다.

1. `wearflag != WIELD` → "무장할 수 없습니다".
2. **마법사 무기 제한**: (SHARP 또는 THRUST) + `ndice·sdice+pdice > 14` + (MAGE/CLERIC) → 거부. 약한 단검류만 허용.
3. **성별**(SHARP/THRUST 한정 ONOFEM/ONOMAL).
4. **슬롯 점유**: `ready[WIELD-1]` 있으면 "이미 무장하고 있습니다".
5. **직업 선택**(OCLSEL), **성향**(OGOODO/OEVILO → 바닥으로), **종족 크기**(§6).
6. **밸런스 소각**: `ndice·sdice+pdice > 39`, `shotsmax/cur > 600`, `ONSHAT && OALCRT` → questnum·ONEWEV 아니면 free("푸른 빛을 내며 사라집니다").
7. **레벨 게이트**(`command3.c:820`):
   ```c
   check_dmg = obj_ptr->ndice * obj_ptr->sdice + obj_ptr->pdice;
   if(class == FIGHTER)               check_dmg -= 7;   // 전투 직업 완화
   if(class == ASSASSIN || THIEF)     check_dmg -= 3;
   if(class == PALADIN || RANGER)     check_dmg -= 2;
   if(class < INVINCIBLE && check_dmg > 15 && !ONEWEV && level < check_dmg*3 && questnum==0)
       "당신의 능력으로는 사용할 수 없는 무기입니다.";
   ```
   무기 dice 기대 데미지에 비례해 레벨을 요구하며(`dice합 × 3`), 물리 직업은 −7/−3/−2만큼 완화된다.
8. **개인 귀속**: `ONEWEV` + `key[2] != 플레이어 이름` → "다른 사람의 물건은 사용할 수 없습니다"(소유자에게 묶인 아이템).

통과하면 `ready[WIELD-1] = obj` → `compute_thaco(ply_ptr)` → `F_SET(OWEARS)` 순으로 처리한다.

**방패**는 wearflag=SHIELD(18)이므로 `ready()`가 아니라 `wear()`가 처리한다(`ready[SHIELD-1]`, AC에 기여).

**쥠 물건**은 `hold()`(`command3.c:860`)가 처리한다.
- wearflag가 HELD 또는 WIELD여야 한다.
- 임무템, 이벤트템, 강력한 무기(dice합 >100)는 거부한다.
- `type < ARMOR`(무기)를 쥐면 `F_SET(OWHELD)`를 켠다.
- HELD 무기는 근접 공격 때 보조 데미지(`+mdice(HELD)/10`, [[a5-combat]])를 준다.

---

## 4. 착용 스탯 효과: `ready[]` 재계산 (공식은 이식 / 트리거는 재설계)

**착용은 능력치 필드를 직접 더하거나 빼지 않는다.** wear/ready/remove는 슬롯 포인터를 넣거나 비운 뒤, 파생 스탯을 **`ready[]` 전체로 다시 계산**한다. 여기서는 [[a7-player-progression]] §11·§12에서 확정한 닫힌 식 가운데 아이템이 기여하는 항만 적는다.

- **AC(방어)**: `compute_ac`(`player.c:971`)는 `100 − 5·bonus[dex] − (Σ ready[i]->armor) − (PPROTE ? 10 : 0)`이고, clamp[−127,127]을 적용한다. **아이템 기여분은 착용 방어구 `armor` 필드의 총합**이다. 방패도 `armor`로 합산된다. 기본 공식과 dex 항은 [[a7-player-progression]] §11에 있다.
- **thaco(명중)**: `compute_thaco`(`player.c:1001`)는 `thaco_list[class][circle] − ready[WIELD-1]->adjustment − mod_profic − bonus[str]`이다. **아이템 기여분은 착용 무기의 `adjustment`(+N)**다. `circle=(level+3)/4` 인덱싱과 나머지 항은 [[a7-player-progression]] §11에 있다.

즉 무기의 `adjustment`는 **명중에만**, `armor`는 **AC에만** 들어간다. 무기가 데미지에 기여하는 부분(`ndice/sdice/pdice`)은 [[a5-combat]]에서 다룬다.

> **구현 시사점**: 착용 효과를 `ready[]` 재계산으로 구현한 것은 [[a7-player-progression]] §12의 "유효 스탯 = 순수 함수" 방향과 이미 맞는다. 다만 재계산을 **수동으로** 호출한다. wear/ready/remove가 `compute_ac`/`compute_thaco`를 직접 부르므로, 호출을 빠뜨리면 값이 stale해진다. 신규 스택은 AC/thaco를 `ready[]`의 파생값으로 두고, 슬롯이 바뀌면 무효화하거나 조회할 때 계산해서 수동 호출을 없앤다.

착용 상태 플래그는 두 가지다. **`OWEARS`(23)**는 착용 중을 뜻한다. 프롬프트에 자주 나오는 `OWORN`은 **존재하지 않는다**. `OWHELD`(49)는 쥠을 뜻한다. 이 플래그들은 인벤토리 목록을 보여 줄 때와, 저장/로드 시 착용 여부를 복원할 때 쓰인다.

---

## 5. 아이템 소비: 물약·두루마기·지팡이 (콘텐츠 → [[a6-magic]])

소비 아이템 3종은 모두 **`magicpower` 필드가 가리키는 스펠을 시전**하고 충전을 소모한다.

| type | 명령 | 핸들러 | 소모 | 시전 컨텍스트 |
|---|---|---|---|---|
| POTION(6) | 마시기 | `drink`(`magic1.c:496`) | `shotscur--` | `spllist[magicpower-1]`를 POTION 컨텍스트로 |
| SCROLL(7) | 읽기 | `readscroll`(`magic1.c:352`) | (소모) | SCROLL 컨텍스트 + `study`로 스펠 학습 가능 |
| WAND(8) | 쏘기 | `zap`(`magic1.c:673`) | `shotscur--` | WAND 컨텍스트, `magicrealm`=계열 |

시전되는 스펠 자체(효과, 데미지, 지속, 마법 저항)는 [[a6-magic]]의 `spllist`/`ospell` 테이블을 기준으로 한다. 이 노트에서 중요한 점은 **아이템이 스펠을 전달하는 수단**이라는 것이다.
- `magicpower-1`이 스펠 인덱스다.
- `shotscur`는 남은 사용 횟수다.
- 두루마기는 여기에 더해 `study`(학습) 경로도 제공한다.

지팡이/열쇠는 `shotscur < 1`이면 다 쓴 것으로 판정한다. 전당포도 이런 아이템을 저품질로 보고 거부한다(§8).

---

## 6. object 플래그 (콘텐츠)

`flags[8]`은 64비트 비트필드다(`mtype.h:476–526`, `F_ISSET(obj, BIT)`). 아이템과 거래에 관련된 비트는 다음과 같다.

| 비트 | 상수 | 의미 |
|---|---|---|
| 6 | OCONTN | 컨테이너 |
| 7 | OWTLES | 무게 없는 보관(내부물 무게 미합산) |
| 10 | ONOMAG | 마법사·성직자 착용/사용 불가 |
| 11 | OLIGHT | 광원 |
| 12 / 13 | OGOODO / OEVILO | 선(align≥−50) / 악(align≤50) 전용 |
| 14 | OENCHA | 인챈트됨 |
| 17 | ONOTAK | 습득 불가 |
| 18 | OSCENE | 방 배경(습득 불가) |
| 19 / 20 | OSIZE1 / OSIZE2 | 부위 크기(§ 아래) |
| 21 | ORENCH | 랜덤 인챈트 대상 |
| 22 | OCURSE | 저주(벗기 거부) |
| 23 | OWEARS | 착용 중 |
| 25 | OCNDES | 담긴 아이템을 삼키는 컨테이너 |
| 26 / 27 | ONOMAL / ONOFEM | 여성 전용 / 남성 전용(**명명 역전**) |
| 28 | ODDICE | object dice 기반 데미지 |
| 31 | OCLSEL | 직업 선택 무기 |
| 32–39 | OASSNO…OTHIEO | 직업별 비트(`OCLSEL + class`) |
| 45 | OMARRI | 기혼자 전용 |
| 46 | OEVENT | 이벤트 아이템 |
| 49 | OWHELD | 쥠 |
| 50 | ONEWEV | 개인 귀속(key[2]=소유자명) |

### 종족 크기 제한 (OSIZE, `command3.c:168`·`774`)

```c
i = (F_ISSET(obj_ptr, OSIZE1) ? 1:0) * 2 + (F_ISSET(obj_ptr, OSIZE2) ? 1:0);
switch(i) {
case 1: /* 소형 */ 착용가능 = GNOME/HOBBIT/DWARF만;
case 2: /* 중형 */ 착용가능 = HUMAN/ELF/HALFELF/ORC만;
case 3: /* 대형 */ 착용가능 = HALFGIANT만;
/* 0 = 제한 없음 */
}
```

크기 3단계(소/중/대)로 착용 가능한 종족을 제한한다. [[a7-player-progression]] §7이 "종족 효과 3종" 중 하나로 꼽은 "장비 크기 제한"을 구현한 부분이다. `class < INVINCIBLE`에만 적용되고, 승급자는 제한을 받지 않는다.

### 직업 선택 무기 (OCLSEL, `command3.c:163`)

```c
if(F_ISSET(obj_ptr, OCLSEL))
  if(!F_ISSET(obj_ptr, OCLSEL + ply_ptr->class) && class < INVINCIBLE)
      "당신의 직업에 맞지 않습니다.";
```

`OCLSEL`(31)이 켜져 있으면, 해당 직업의 `OCLSEL + class` 비트(32~39, OASSNO=자객…OTHIEO=도둑)도 켜져 있어야 착용/장착할 수 있다. class 열거가 1부터 시작하므로 `OCLSEL+class`가 직업 비트 위치와 맞아떨어진다([[a7-player-progression]] §6 클래스 상수).

### rand_enchant 확률표 (`object.c:258`)

`ORENCH`(랜덤 인챈트) 아이템은 생성될 때 인챈트를 굴린다.

```c
m = mrand(1,100);
if(m > 98)      { OENCHA; adjustment=3; pdice+=3; }   // 3%
else if(m > 90) { OENCHA; adjustment=2; pdice+=2; }   // 8%
else if(m > 50) { OENCHA; adjustment=1; pdice+=1; }   // 40%
/* ≤50: 변화 없음 (50%) */
obj_ptr->pdice = MAX(obj_ptr->pdice, obj_ptr->adjustment);
```

결과는 +1(40%)/+2(8%)/+3(3%)/변화없음(50%)이다. adjustment는 명중과 데미지에, pdice는 데미지에 반영된다.

---

## 7. 금화 경제 (규칙은 이식 / 필드는 재설계)

금화는 **`creature.gold`**(long, offset 348, `mstruct.h:189`)다. **상한이나 음수를 막는 가드가 없다.** 어디에서도 clamp하지 않으며, 가문에 가입하면 `+= family_gold*10000`, 불태우기에서 대박이 나면 `+= 100000`까지 더한다.

**금화가 늘거나 줄어드는 지점**(`command grep`으로 전부 조사):

- **몹 처치 드롭**(`creature.c:331`): 몹에게 `gold`가 있으면 `die()`가 `load_obj(0,…)`(objnum 0 = 머니 템플릿)로 MONEY object를 만들고, `obj->value = crt->gold`로 설정해 방에 떨어뜨린다. 즉 **몹의 소지금이 그대로 바닥의 "N냥" 오브젝트가 된다**.
- **몹 소지금 랜덤화**(`creature.c:879`): 스폰할 때 `if(!MNRGLD && crt->gold) crt->gold = mrand(gold/10, gold)`를 적용한다. 고정금액 플래그(MNRGLD=25)가 없으면 소지금이 10~100% 사이에서 랜덤으로 정해진다. 몹 재고 아이템도 `value = mrand(value·9/10, value·11/10)`로 ±10% 변동한다(`creature.c:872`).
- **줍기**(`command2.c:807/888/990/1105`, 은행 553): `if(type==MONEY){ gold += value; free_obj; }` — 오브젝트는 사라지고 gold에 더해진다.
- **떨어뜨리기**(`drop_money`, `command2.c:1444`): `load_obj(0)`로 MONEY object를 만들고 `name="N냥"`, `value=amt`로 설정해 방에 추가한 뒤 `gold -= amt`.
- **양도**(`give_money`, `command8.c:143`): `"N냥"` 접미사를 파싱하고, `amt<1 || amt>gold`면 거부한다. 받는 쪽은 `gold += amt`, 주는 쪽은 `gold -= amt`다. **세금이나 수수료는 없다**.
- **기타 수입**: 불태우기는 `gold += 4`이고, 1/250 확률로 `gold += 100000`이다(`command2.c:1742`). 가문 가입 시에도 들어온다(`command11.c:638`).

---

## 8. 상점·전당포·수리·거래 (콘텐츠 공식)

서비스를 쓸 수 있는지는 **방 플래그**로 정해진다(`mtype.h:304–312`).

| 플래그 | 값 | 방 |
|---|---|---|
| RSHOPP | 0 | 상점(구매) |
| RDUMPR | 1 | 덤프 |
| RPAWNS | 2 | 전당포(판매) |
| RREPAI | 7 | 수리점 |
| RBANK | 39 | 은행(§9) |
| RMARRI | 41 | 결혼 |

### 구매 — `buy` (`command7.c:169`), 정가·복제·무소진

```c
load_rom(rom_num + 1, &dep_ptr);          // 재고 = 인접방 rom_num+1 ("창고방")
if(ply_ptr->gold < obj_ptr->value) 거절;  // 정가 = value (1:1)
obj_ptr2 = malloc; *obj_ptr2 = *obj_ptr;  // 복제
F_CLR(OPERM2/OPERMT/OTEMPP);              // 영구 플래그 제거 후 지급
ply_ptr->gold -= obj_ptr->value;          // 재고는 소진되지 않음
```

**구매가 = `value`**(배수 없음). 재고는 **인접 방 번호 `rom_num+1`**(상점 방 바로 다음 번호)에 실제로 놓인 오브젝트를 복제해 준다. "상점 방 = 진열, rom_num+1 = 창고"라는 규약이다. 원본 오브젝트는 그대로 남으므로 **재고가 무한**하다. 개수 한도는 200이다(장착 포함 `count_inv`).

### 몹 상점 — `purchase` (`command10.c:492`)

몹이 `MPURIT`(36) 플래그를 가지면 상인이다. 재고는 `crt->carry[]`의 objnum이며, `load_obj`로 **템플릿을 복제**하므로 무한하다.

```c
amt = MAX(10, obj_ptr->value * 1);        // command10.c:573 — 최저 10냥
if(ply_ptr->gold < amt) 거절;
gold -= amt; add_obj_crt(복제본);
```

**몹 구매가 = `max(10, value)`**다(`*1`은 의미가 없다). 개수 한도는 150이다.

### 판매 — `sell` (`command7.c:227`), 전당포 50%

```c
gold = MIN(obj_ptr->value / 2, 100000);   // command7.c:258 — 50%, 상한 10만
```

**판매가 = `min(value/2, 100000)`**. `RPAWNS` 방에서만 팔 수 있다. 거부 조건은 다음과 같다(`command7.c:252–277`).

- `gold < 20`(= value < 40) → "그런 쓰레기는 안사요".
- **저품질**: 무기/방어구 `shotscur ≤ shotsmax/8`, 지팡이/열쇠 `shotscur < 1`.
- `ONEWEV`(개인 귀속) → 거부.
- 내부에 다른 오브젝트가 든 컨테이너(`first_obj`) → 거부.
- SCROLL 또는 POTION → 거부("두루마기나 독약같은것은 안사요").

**1/250 확률 "기분 좋은 날" 2배 지급은 정상 동작이다**(`command7.c:272`):

```c
if(((time(0)+mrand(1,100))%250) == 9) {
    print(… "두배로 드리죠" … gold*2);
    ply_ptr->gold += gold;                 // if 내부: +gold
}
else { print(… gold); }
ply_ptr->gold += gold;                     // if/else 밖: 또 +gold
```

lucky 분기는 if 안에서 한 번, if/else 밖에서 또 한 번 더하므로 **실제로 2배**를 지급한다. 화면 표시 `gold*2`와도 맞는다. normal 분기는 밖에서만 더하므로 1배다. **버그가 아니다.** 다만 `time(0)` 기반 확률은 구현 방식이므로 결정적 스케줄러로 대체한다.

### 수리 — `repair` (`command8.c:196`), 25%

```c
cost = obj_ptr->value / 4;                             // 수리비 = 25%
broke = mrand(1,100) + bonus[ply_ptr->piety];          // 신앙심이 높을수록 실패↓
if((broke <= 15 && shotscur < 1) || (broke <= 5 && shotscur > 0)) {
    "수리를 하다 부러뜨렸네";
    ply_ptr->gold += cost;                             // 실패 시 전액 환불
    free_obj(obj_ptr);                                 // 아이템은 소멸
}
else shotscur = shotsmax * mrand(5,9)/10;              // 성공: 내구 50~90% 회복
```

**수리비 = `value/4`**. 실패 확률은 `bonus[piety]`만큼 줄어든다(신앙심이 높을수록 덜 부서진다). 실패하면 아이템은 사라지지만 수리비는 돌려준다. 전당포의 `value` 조회 명령은 판매가(`value/2`, 상한 10만)를, 수리점 견적은 `value/4`를 보여 준다(`command7.c:294`, `command8.c` value 경로).

### 교환·양도

- **trade**(`command10.c:664`, 몹 `MTRADE=37`): 물물교환이다. `ONAMED`(명명) 아이템은 교환할 수 없고, 마모품(`shotscur ≤ shotsmax/10`, MISC 제외)은 거부한다. 대가로 주는 objnum은 `carry[found+4]`다. 몹이 받은 물건을 보관하지 않는 미완성 로직이다(§10).
- **give**(`command8.c:28`): 다른 플레이어에게 양도한다. questnum 임무템(class<DM), `ONEWEV`, 이벤트템, 이런 아이템을 담은 컨테이너는 줄 수 없다. 대상이 PLAYER가 아니면 거부한다.
- **get 거부**(`command2.c:694`): `ONOTAK`, `OSCENE`, `OINVIS`, 이미 완수한 questnum, `MGUARD`(7) 몹이 지키는 경우, "초인의 돌"(value==1001).

### 소지 한도

무게(`weight_ply + weight_obj > max_weight(ply)`, [[a7-player-progression]])나 개수가 한도를 넘으면 거부한다. 개수 상한은 **get/give/purchase = 150**, **buy = 200**(장착 포함)이다. 컨테이너 무게는 `weight_obj`가 내용물을 재귀적으로 합산하되, `OWTLES`(무게 없는 보관) 아이템은 제외한다(`object.c:238`).

---

## 9. 은행 (구현 방식 중심)

은행은 **구조가 특이하다**. 잔고가 `creature` 필드가 아니라 플레이어별 별도 object 파일에 있다.

### 저장 구조 (원작 구현 방식 — MongoDB 설계 직결)

- 파일 경로: `PLAYERPATH/bank/<플레이어이름>`(`bank.c:12`).
- 이 파일은 **단일 `object`**이며 컨테이너로 동작한다. 현금은 `object.value`(long, offset 300)에, 보관 물품은 그 object의 중첩 인벤토리(`first_obj`)에 담긴다.
- 직렬화는 방·몬스터와 **같은 `read_obj`/`write_obj`**를 쓴다(352B object + `int cnt` + 중첩 obj 재귀, [[a4-movement-rooms]]).
- 빈 계좌 초기화(`bank.c:308`): `malloc` + `zero` + `shotsmax = 200`(보관 슬롯 상한).
- 거래할 때마다 `save_bank(name, bnk_ptr)`와 `savegame_nomsg(ply_ptr)`를 **둘 다** 호출해, 은행 파일과 플레이어 세이브를 함께 갱신한다.

### 명령어 (`global.c:339–343`)

| 한글 | 핸들러 | 동작 |
|---|---|---|
| `잔액` | `bank` | 현금 잔고 조회 |
| `입금` | `deposit` | 소지금 → 계좌 |
| `출금` | `withdraw` | 계좌 → 소지금 |
| `보관물` | `bank_inv` | 보관품 목록 / 물품 입고(`input_bank`) |
| `받아` | `output_bank` | 보관 물품 출고 |

모든 핸들러는 시작할 때 `F_ISSET(parent_rom, RBANK)`(39)를 검사한다("은행에서만 가능합니다").

### 현금 이동

```c
// 입금 (bank.c:308~)   deposit
if(bnk_ptr->value + amt > 300000000) { "3억이상 입금할 수 없습니다"; return; }  // 상한 3억
bnk_ptr->value += amt;  ply_ptr->gold -= amt;

// 출금 (bank.c:375~)   withdraw
if(amt > bnk_ptr->value) 거부;
bnk_ptr->value -= amt;  ply_ptr->gold += amt;
```

- 입력은 `"N냥"` 접미사를 파싱하고(`atol`), `amt < 1`이면 거부한다("음수가 될수 없습니다"). `입금 모두`는 소지금 전부, `출금 모두`는 잔고 전부다.
- **잔고 상한은 3억**(300000000, `bank.c:314`)이다. 수수료는 없고(1:1), **이자도 없다**. 전체 소스에서 `interest`/`이자`를 grep하면 0건이다. 단순한 금고다.
- **이체·송금 없음**: 각 계좌는 `bank/<본인이름>` 파일로 분리돼 있다. 물품을 꺼낼 때 MONEY 타입 오브젝트는 gold에 더해진다.
- 물품 보관 슬롯 상한은 200이다(`shotscur ≥ shotsmax`면 "더이상 넣을 수 없습니다"). 컨테이너(OCONTN) 계열은 보관할 수 없다.

### `bank_check.c` — 독립 관리 유틸 (데몬 아님)

`bank_check.c`는 게임 서버가 아니라 **오프라인에서 쓰는 관리자 편집 유틸리티**다(`void main()`이 있다). 콘솔에서 플레이어 이름을 받아 계좌 파일을 로드하고 조회하며, 파일이 없으면 빈 계좌를 만든다. 이름의 "check"는 이자 점검이 아니라 계좌 파일이 있는지 확인하고 조회한다는 뜻이다. 이자 정산 배치나 틱과는 관계가 없다.

### 부수

- **자살 처리**(`command5.c:711`): 계좌 파일을 `suic/<name>.bank`로 옮긴다. 삭제하지 않고 따로 보관한다.
- **불량 아이템 정리**(`special1.c:297`): 로그인이나 점검 때 은행 컨테이너를 최대 200개까지 순회하며 `is_bad_item`을 로깅한다. 잔고는 바꾸지 않는다.

---

## 10. 구현 방식·버그·데드코드 목록 (재설계 / 비재현 후보)

| # | 항목 | 성격 | 처리 |
|---|---|---|---|
| a | **은행 = 별도 object 파일 컨테이너**(`bank/<이름>`, 현금=value) | 구현 방식 | MongoDB 문서 `{owner, gold, items[]}`. player 인라인 또는 별도 컬렉션 모두 원본 의미와 일치 |
| b | **`ready[20]` 포인터 배열** — 디스크상 4B 포인터×20, 로드 시 무의미 | 구현 방식 | 착용 슬롯을 objectId 참조로. 저장은 착용 여부(OWEARS)로 복원 |
| c | **상점 재고 = `rom_num+1` 인접방 규약** — 방 번호 인접에 의존 | 구현 방식 | 명시적 재고 목록(shop inventory) 모델. 복제·무소진은 규칙으로 이식 |
| d | **`gold` signed long 무가드** — 상한·음수 검증 없음, `+=100000` 등 | 구현 방식/결함 | 상한·검증 추가(또는 BigInt/unsigned) |
| e | **`time(0)` 기반 확률**(전당포 2배 `command7.c:272`) — 벽시계 의존 | 구현 방식 | 결정적 RNG/스케줄러로 대체(확률 1/250은 유지) |
| f | **은행 초기화 `F_ISSET(bnk_ptr, OCONTN)`**(`bank.c:311`) — 테스트 매크로를 설정처럼 호출, **플래그가 실제로 안 켜짐** | 버그(데드) | 신규 계좌 문서는 컨테이너 성격을 명시. 원본 OCONTN 의존 코드 영향 재확인 |
| g | **trade 몹이 받은 물건 미보관**(`command10.c` 주석 처리) — 대가만 지급 | 미완성 | 물물교환을 완결형으로 재설계할지 결정 |
| h | **CONTAINER2(14)** — 헤더 정의되나 help 미기재, 실사용 미확인 | 불명 | `data/world/objects.json` 카운트로 확정, 0이면 제외 |
| i | **파생 스탯 수동 재계산 트리거** — wear/ready/remove가 `compute_ac`/`compute_thaco` 직접 호출(누락 시 stale) | 구현 방식 | [[a7-player-progression]] §12대로 유효 스탯 함수화 |
| j | **밸런스 소각 임계 하드코딩**(AC>151, dice합>39, shots>600) — 매직넘버 | 구현 방식 | 아이템 검증 규칙을 데이터/config로 |

---

## 11. 아키텍처 시사점

1. **아이템 = 단일 `object` 문서, 착용은 슬롯 참조.** 무한의 모든 컨테이너(방·몹·플레이어·은행)가 같은 object를 담는다. 따라서 MongoDB에서도 object를 단일 스키마로 모델링하고, 컨테이너는 objectId 배열로 참조한다. 착용은 `ready[]` 슬롯을 objectId 맵(`{ WIELD: id, BODY: id, … }`)으로 재현한다.

2. **파생 스탯은 `ready[]`의 순수 함수**다(§4). AC=`f(dex, Σ 착용 armor, 보호)`, thaco=`f(class, level, 무기 adjustment, 숙련, str)`이다. 착용/해제할 때 필드를 더하고 빼는 대신 "슬롯 변경 → 재계산"으로 처리하면, [[a7-player-progression]] §12의 최우선 재설계(base+modifier 분리)와 자연스럽게 합쳐진다. 무기 `adjustment`는 명중 modifier로, 방어구 `armor`는 AC modifier로 각각 태깅한다.

3. **경제는 `value` 하나에 상수 배수를 곱하는 구조다.** 구매 100%, 판매 50%(cap 10만), 수리 25%, 몹 구매 max(10,value)다. 이 배수는 코드가 아니라 **경제 config**(JSON)에 두어 튜닝을 코드와 분리한다. `value`는 아이템 템플릿의 기준 필드로 이식한다.

4. **상점 재고를 선언적으로 정의한다.** 원본은 재고를 "인접 방 번호 규약"으로 표현한다(§8). 이는 방 번호가 이웃해야만 동작하는 구현 방식이다. 신규 스택은 상점에 명시적인 재고 목록(무한/유한, 복제 여부)을 주고, 몹 상점의 `carry[]`도 상인 인벤토리로 모델링한다.

5. **은행은 계좌 도메인으로 분리한다**(§9). 원본의 "은행=object 파일 컨테이너"는 기존 구조를 잘 재사용한 것이지만 원작의 구현 방식이다. 계좌를 `{owner, gold, items[], slotLimit:200, cap:3억}` 문서로 두면 현금과 보관 물품을 명확히 나누면서도 원본 의미(이자 없음, 3억 상한, 이체 없음)를 그대로 이식할 수 있다. **이자가 없다는 점은 설계상 선택할 지점**이다. 무한 원작에 충실할지, 경제를 확장할지 결정해야 할 항목으로 표시한다.

6. **금화 무결성 가드를 추가한다.** gold, value, 잔고가 모두 가드 없는 signed long이다. 신규 스택은 상한, 음수 검증, 트랜잭션(입금/출금/판매의 원자성)을 넣는다. 특히 은행은 두 파일(계좌+세이브)을 함께 저장하므로, 일부만 실패하면 금화가 사라지거나 복제될 위험이 있다.

7. **콘텐츠/구현 방식 경계를 확정한다.**
   - 이식: §1 타입 taxonomy, §2 착용 슬롯·게이트, §3 무기 레벨게이트, §5 소비 아이템의 스펠 전달, §6 플래그 의미·rand_enchant·종족 크기, §7 금화 드롭, §8 가격 배수·거래 거부·소지 한도, §9 은행 규칙(3억·200슬롯·이자 없음).
   - 재설계/비재현: §10 전 항목(은행 파일 구조, `ready[]` 포인터, 재고 방 규약, 가드 없음, time(0), OCONTN 데드 statement, 미완성 trade).

---

## 검증 메모

- **직접 읽어 확인**(byte-level): `wear`·`wear_all`·`remove_all`·`ready`·`hold`·`equip_list`(command3.c 전 게이트·슬롯 설정 로직), object type/wearflag/object-flag 상수(mtype.h:123–139·206–230·476–526), 상점 방 플래그(mtype.h:304–312·340·342), OBJ/CRT 오프셋(templates.js).
- **경제·은행 핵심 수치 원본 재확인**(에이전트 단독 출처였던 load-bearing 값): 판매가 `MIN(value/2, 100000)`(command7.c:258 확정), 수리비 `value/4`(command8.c:249 확정), 몹구매 `MAX(10, value*1)`(command10.c:573 확정), 은행 3억 상한 `value+amt > 300000000`(bank.c:314 확정), 현금=object.value(입금 `bnk_ptr->value += amt` 확정), buy 함수명(command7.c:169 확정).
- **정정**: 전당포 "2배 지급"은 **버그가 아니라 정상 동작**이다. lucky 분기는 if 안의 `gold += gold`와 if/else 밖의 가산이 겹쳐 실제로 2배를 지급한다(command7.c:277·284 확인). 처음 추출할 때는 이를 미지급 버그로 잘못 읽었으나, 라인을 다시 확인해 정정했다. 이와 별개로, 은행 초기화의 `F_ISSET(bnk_ptr, OCONTN)`(bank.c:311)은 테스트 매크로를 잘못 써서 플래그가 실제로 켜지지 않는 **데드 statement**다(§10-f).
- **에이전트 추출 + 직접 확인 안 함**(신뢰하되 인용 라인 표기):
  - 소비 아이템의 magic1.c 시전 경로(`drink`/`readscroll`/`zap`, magicpower-1 → [[a6-magic]] 위임)
  - `die()` 금화 변환(creature.c:331)·몹 소지금 랜덤(creature.c:879)
  - give/trade/get 거부 조건 세부(command8.c·command10.c·command2.c)
  - bank_check.c가 독립 유틸이라는 점
- **위임**: 무기 데미지·명중·숙련 공식은 [[a5-combat]], 물약/두루마기/지팡이 스펠 효과와 마법 계열은 [[a6-magic]], AC/thaco 닫힌 식·`max_weight`·스탯 보정은 [[a7-player-progression]]이 담당한다. 이 노트는 아이템 기여 항(Σ armor·adjustment)만 더했고, 기본 공식은 다시 유도하지 않았다.
- **미확인/근사**: CONTAINER2(14)가 실제로 쓰이는지는 `data/world/objects.json`에서 개수를 세어 확정해야 한다. 원거리/특수공격의 type별 분기는 command5.c 근접 경로만 확인했다(special1.c 등은 꼼꼼히 읽지 않았다). 몹 `carry[]` 5칸과 오버로드(carry[0]=WIMPYVALUE) 세부는 몹 AI 범위로 넘긴다.
- `command grep` 래퍼가 `-I`로 EUC-KR 파일을 건너뛰는 함정을 다시 확인했다. `command grep -a`/`iconv`를 쓴다([[muhan-oracle-toolchain]]).
