# A1 런타임 루프·틱·타이밍 모델

> 무한 서버의 메인 루프, 틱(heartbeat) 케이던스, 엔티티 타이머 메커니즘을 oracle에서 추출한다. 이슈 #1. 출처는 `legacy/muhan/src`.

## 개요

원본은 **단일 프로세스 select 멀티플렉싱** 서버다. 하나의 무한 루프가 모든 플레이어 소켓을 select로 다중화하고, 매 반복 끝에서 시간 구동 틱 `update_game()`을 돌린다. 게임 시계 단위는 **초**(`time(0)`)이며, 전투·몬스터·환경 갱신은 모두 이 초 단위 틱 위에서 간격 게이트로 동작한다. 엔티티별 쿨다운은 `lasttime` 타이머 배열로 표현된다.

## 런타임 루프 구조

메인 루프는 `sock_loop` 하나다 (`io.c:199`):

```c
void sock_loop() {
    while(1) {
        if(Deadchildren) reap_children();
        io_check();          // select(75ms) + 입력 수신
        output_buf();        // 출력 버퍼 flush
        handle_commands();    // 플레이어별 명령 1개 디스패치
        update_game();        // 시간 구동 틱
    }
}
```

- `io_check` (`io.c:220`)는 `select(Tablesize, ..., &t)`를 `t = {0, 75000}` = **75ms 타임아웃**으로 호출한다. 입력이 없으면 최대 75ms 블록하므로 유휴 루프는 약 13Hz로 회전하고, 입력 반응 지연 상한은 75ms다.
- 새 연결은 `Waitsock`이 readable일 때 `accept_connect`로 수락한다. 플레이어 상태는 `Ply[]` 배열 + 플레이어별 `iobuf`로 관리한다.
- `handle_commands` (`io.c:754`)는 플레이어 입력 링버퍼에서 CR/LF까지 **한 줄만** 꺼내 `commands--` 후 `(*Ply[i].io->fn)()`로 디스패치한다 (`io.c:787-802`). 버퍼에 여러 명령이 큐잉돼 있어도 **회전당 플레이어 1개**만 처리되고 나머지는 다음 회전으로 미뤄진다. 명령 문법·디스패치 테이블은 A2에서 다룬다.

### 동시성: 단일 프로세스

`fork()`는 게임 루프에 없다. `main.c:39`에서 데몬화("go into background") 1회, `startm.c`는 외부 워치독 재시작기, `s.c`는 유틸리티에서만 쓴다. `io.c`·플레이어 접속 경로에는 `fork`가 없다. 즉 모든 플레이어 로직은 **한 프로세스의 단일 루프**에서 순차 실행된다.

## 틱 모델 (heartbeat)

`update_game` (`update.c:40`)은 루프마다 호출되지만 초 단위로 게이트된다:

```c
t = time(0);
if(t == last_update) return;   // 같은 초면 즉시 반환 → 실질 1Hz
last_update = t;
```

→ **기본 heartbeat = 1초(1Hz)**. 같은 초 안의 추가 호출은 즉시 반환한다. 그 안에서 하위 시스템이 각자의 간격으로 게이트된다:

| 하위 시스템 | 간격(초) | 역할 | 출처 |
|---|---|---|---|
| `update_active` | **매초** (`t != last_active_update`) | 활성 크리처 처리 — 전투 라운드 진행, 적대 행동 | `update.c:53` |
| `update_users` | ≥20 | 플레이어 타임아웃 플래그·유휴 점검(유휴 300초 경고 후 disconnect, DM 제외) | `update.c:49,85` |
| `update_random` | ≥`Random_update_interval` | 플레이어 점유 방에 랜덤 몬스터 스폰 | `update.c:51,114` |
| `update_time` | ≥150 | 게임 시간(주야 등) 진행 | `update.c:55` |
| `update_monster` | ≥4000 | 몬스터 갱신(저빈도) | `update.c:59` |
| `update_monster_two` | ≥5000 | 몬스터 갱신 2 | `update.c:61` |
| `update_moonstone` | ≥20000 | 환경 이벤트 | `update.c:57` |
| `update_exit` | ≥`TX_interval` | 출구 개폐 | `update.c:64` |
| `update_shutdown` | ≥30 (종료 예약 시) | 종료 카운트다운 | `update.c:66` |

전투·즉시성이 필요한 처리는 `update_active`에 모여 **매초** 평가된다. 긴 간격(4000·5000·20000초)은 저빈도 환경 갱신이다. `Random_update_interval`·`TX_interval`은 런타임 전역값이다(상수 정의는 미발견, 별도 확인 대상).

## 엔티티 타이머 메커니즘 (lasttime / LT)

크리처·방의 모든 시간 제약은 `lasttime` 구조체로 표현된다 (`mstruct.h:53`, 크기 12B — 확정 구조체 크기와 일치):

```c
typedef struct lasttime {
    long  interval;   // 쿨다운 길이(초)
    long  ltime;      // 마지막 수행 시각
    short misc;
} lasttime;
```

매크로 `LT(a,b)` (`mtype.h:585`)는 다음 가용 시각을 계산한다:

```c
#define LT(a,b)  ((a)->lasttime[(b)].ltime + (a)->lasttime[(b)].interval)
```

→ `LT(crt, slot) < t`(현재 초)이면 쿨다운 만료 = 해당 행동 가능. 예: `update_active`에서 `i = LT(crt_ptr, LT_BEFUD); if(i < t)` 형태로 행동 가부를 판정한다.

- 크리처는 `lasttime[45]` (`mstruct.h:206`) — 45개 시간 제약 슬롯. 인덱스는 `LT_` 상수다 (`mtype.h:159~`): `LT_INVIS`=0, `LT_ATTCK`=3, `LT_SPELL`=9, `LT_HEALS`=8, `LT_STEAL`=5 등.
- 방은 `ltime`(개폐, `mstruct.h:108`)과 `perm_mon[10]`·`perm_obj[10]`(재출현 몬스터·아이템, `mstruct.h:154`)을 가진다.

즉 타이밍은 두 층이다 — **중앙 1Hz 틱**(언제 평가하는가) + **엔티티별 `lasttime` 쿨다운**(각 행동의 다음 가용 시각). 전투 라운드 길이·주문 재시전·은신 등은 전부 슬롯별 `interval` 값으로 인코딩된다.

## 콘텐츠/형상 분류

| 구분 | 항목 |
|---|---|
| **콘텐츠 (충실히 이식)** | 1초 틱 의미, 각 `update_*` 주기 값(20·150·4000·5000·20000초 등), 슬롯별 `lasttime.interval` 쿨다운 값, `update_active`가 매초 전투를 진행한다는 규칙, 유휴 300초 disconnect 정책, 방 재출현 타이머 의미 |
| **형상 (재설계)** | `sock_loop`+`select(75ms)` → Node 이벤트 루프(입력은 WebSocket push라 폴링 타임아웃 불요), `iobuf`/`output_buf` → WebSocket 송신, `lasttime[45]` 배열+`LT` 매크로 → JS 타이머/스케줄러 표현, `time(0)` 초 비교 → 단조 시계 기반 스케줄러, `main.c` 데몬화·`startm.c` 워치독 → 프로세스 매니저(systemd/pm2 등) |

## 아키텍처 함의 (이슈 #14 입력)

**런타임 루프는 손으로 만든 비동기 기반이다.** 1990년대 C 환경엔 스레드·async I/O·이벤트 루프 라이브러리가 없었으므로, 무한은 단일 스레드에서 다수 동시 행위자를 돌리기 위해 이벤트 루프(`sock_loop`)·I/O 멀티플렉싱(`select`)·타이머 서브시스템(`lasttime`+`LT`)·협력적 스케줄링(회전당 명령 1개)을 직접 구현했다. Node(libuv 이벤트 루프 + 타이머)가 정확히 이 기반의 네이티브 대응물이므로 — 같은 문제의 같은 해법이라 우연이 아니다 — **이 루프는 포팅하지 않고 삭제하며 플랫폼의 것을 채택한다.**

분리 원칙: **메커니즘은 형상, 그 위에 실린 타이밍 값·순서는 콘텐츠.** `select`·`iobuf`·`output_buf`·`lasttime` 배열·`LT` 매크로·`time(0)` 초 단위 폴링은 형상으로 버리고 플랫폼으로 대체한다. 1Hz 케이던스·각 `update_*` 간격 값·슬롯별 쿨다운 duration·`update_active`가 매초 돈다는 순서는 콘텐츠로 재현한다. `lasttime[45]` 배열을 버린다고 쿨다운 *값*까지 버리지 않는다.

- **단일 이벤트 루프로 충분하다.** 원본도 단일 프로세스다. 멀티프로세스·Redis는 수평 확장 시점에만 도입한다.
- **중앙 heartbeat = 1Hz `setInterval`**이 원본 `update_game`과 직결된다. 75ms select 타임아웃은 입력 반응 상한일 뿐이며 WebSocket(push)에는 대응물이 없다.
- **전투·활성 처리 권장 모델**: 엔티티마다 `setTimeout`을 남발하지 않고, **매초 활성 리스트를 순회**하며 엔티티별 "다음 가용 시각"(`lasttime` 대응 필드)을 비교하는 방식이 원본과 일치하고 결정적이다.
- **긴 주기 갱신**(몬스터 4000s·moonstone 20000s 등)은 저빈도 스케줄 작업으로 분리한다.
- **게임 시계 단위 = 초.** 밀리초 정밀도는 불필요하며, 초 단위 단조 틱이 원본 동작을 재현한다.
- **결정 필요(#14)**: 1초 틱 granularity가 설계 의도(MUD 라운드 페이스 = 콘텐츠)인지 `time(0)` 사용의 환경 한계인지. 현 판단은 콘텐츠 쪽(라운드 박자는 플레이어 체감 페이스)이며, 1Hz 전투 케이던스를 충실히 재현하는 쪽으로 기운다.

## 다음 분석으로 이월

이 노트는 A1(런타임 루프·틱) 범위에 한정한다. 인접 주제는 해당 분석에서 다룬다:

- `Random_update_interval`·`TX_interval` 실제 값은 전역 초기화 위치에서 확인한다(A1 결론에 영향 없음 — 둘 다 런타임 전역).
- `update_active` 본문의 전투 라운드 진행 로직 → A5(전투).
- `update_ply`(플레이어 단위 갱신: hp/mp 재생 등) → A7(플레이어 진행).
