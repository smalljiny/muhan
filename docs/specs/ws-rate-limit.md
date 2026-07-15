# WS 인바운드 메시지 유량 제한

> 인증된 `/game` WebSocket 연결의 **인바운드 프레임 도착률**에 연결별·계정별 토큰 버킷 상한을 걸어, 읽기는 정상이면서 프레임을 고속 flood해 파싱·dispatch CPU를 소진시키는 공격을 `JSON.parse` 이전에 차단하는 E3 전송 계층 하드닝.

## 개요

E3 하드닝 후속(#64). [`ws-resource-guard.md`](ws-resource-guard.md)(#54)가 **연결 수**(정원 게이트)와 **아웃바운드 큐**(backpressure)를 상한했지만, 인증된 클라이언트가 **읽기는 정상**이면서 프레임을 고속으로 flood하면 인바운드 처리 CPU(파싱·dispatch·핸들러)를 소진시킬 수 있다. 기존 완화는 이 표면을 덮지 못한다.

- `maxPayload`(`MAX_FRAME_BYTES = 64KB`)는 **프레임 크기**만 막고 **도착률**을 막지 않는다.
- backpressure는 **아웃바운드** 큐만 막고 인바운드 처리율을 막지 않는다.

이 문서는 인바운드 유량 상한과 이를 튜닝하는 `WS_MSG_RATE_*` env 정책값을 정본으로 소유한다. 게이트가 걸리는 지점은 [`transport-protocol.md`](transport-protocol.md)의 message 처리 파이프라인(`JSON.parse` 최상단)이며, `error{code:'rate_limited'}` 통지는 같은 문서의 `errorCodeSchema` 계약을 쓴다.

이 방어는 기존 자원 방어와 **다른 층**이다: `maxPayload`(프레임 크기) → **rate limit(도착률, 신규)** → backpressure(아웃바운드 큐) → idle-nonrearm(유휴 종료). rate limit 드롭이 idle 타이머를 재-arm하지 않는 것은 rejected-nonrearm과 같은 원리 — flood는 유휴 종료를 앞당겨야지 연장해선 안 된다.

## 구조 / 스키마

### 유량 제한 코어 (`packages/server/src/ws/messageRateLimiter.ts`)

`createMessageRateLimiterFactory(getLimits)` 팩토리가 계정별 공유 버킷 레지스트리(`Map<accountId, AccountEntry>`)를 클로저에 캡슐화하고 `MessageRateLimiterFactory` 핸들을 반환한다(`connectionQuota` factory+thunk+공유 회계 관례 미러 — 정원 카운터에 얹지 않는 별도 레지스트리다).

- `createConnection(accountId): ConnectionRateLimiter` — 연결 하나의 유량 제한 핸들을 발급한다. 계정 엔트리가 있으면 refCount를 올려 공유 버킷을 참조하고, 없으면 새 버킷을 refCount=1로 등록한다. 연결 전용 버킷과 위반 카운터는 이 핸들이 소유한다.
- `releaseAccount(accountId): void` — 계정 참조 반납. refCount를 내리고 0 도달 시 Map 엔트리를 삭제한다. 부재 계정 release·이중 반납은 완전 no-op(음수·누수 없음).
- `activeAccountCount(): number` — 테스트 전용 인스펙터(살아 있는 계정 엔트리 수). 프로덕션 회계 미참여.

`ConnectionRateLimiter` 핸들:

- `check(now): RateVerdict` — 연결 버킷과 공유 계정 버킷을 원자적으로 AND한 순수 판정. `'accept'`(둘 다 토큰 소비 성공)·`'drop'`(고갈 폐기)·`'drop-warn'`(고갈 폐기이면서 연속 폐기 구간의 첫 폐기 → 상위가 1회 경고).
- `shouldTerminate(): boolean` — 연속 위반 카운터가 `maxViolations` 임계에 도달했는지.
- `peekConnectionTokens()`/`peekAccountTokens()` — 테스트 전용 인스펙터(각 버킷 미소비 관측).

토큰 버킷은 잔여 토큰과 마지막 리필 시각만 소유하는 순수 헬퍼다. 첫 `check`는 `lastRefill === null` 센티넬로 capacity를 시드하고(lazy seed), 이후 자체 경과에 비례해 리필하되 capacity에서 clamp한다. AND 게이트가 "둘 다 검사 → 둘 다 소비"를 부분 소비 없이 마치도록 `hasToken`/`consume`을 분리한다. `now`는 단조 비감소로 가정한다.

상한은 thunk(`getLimits`)로 매 `check`에서 지연 조회한다(정원 관례 미러) — 미설정 env가 팩토리 생성을 막지 않게 한다. 상태는 `registerWebsocket` 스코프에서 1회 생성해 연결 간 공유한다.

### 컨텍스트 슬롯 (`packages/server/src/ws/connection.ts`)

`ConnectionContext`에 `rateLimiter: ConnectionRateLimiter | null` 슬롯을 추가한다(`deadline`/`idle` 슬롯 관례 미러). 소켓 open 시 팩토리가 핸들을 대입하고, `cleanupConnection`이 슬롯을 null로 비운다 — 순수 회계 핸들이라 clear할 타이머가 없어(heartbeat/deadline/idle과 달리 null 전 부수효과가 없다) 무조건 대입으로 충분하다. **계정 버킷 반납은 여기서 하지 않는다** — 별도 close 리스너(`releaseAccount`)가 소유한다(여기서 반납하면 이중 감소로 형제 연결의 계정 엔트리를 지운다).

### 게이트 배선 (`packages/server/src/ws/plugin.ts`)

`registerWebsocket` 스코프에서 팩토리를 1회 인스턴스화해 `app.wsMessageRateLimiter`로 노출한다(진단·테스트 관찰의 단일 출처, `wsSessionRegistry` 관례 미러). 상한 projection은 첫 `check`에서 한 번만 만들어 캐시한다 — `check`는 매 프레임 도는 hot path라 프레임마다 새 5-필드 객체를 할당하면 flood 시 공격률에 비례한 GC garbage가 된다. config는 첫 파싱 후 불변이므로 캐시 수명(=팩토리 수명)에 staleness가 없다.

### Env 정책값 (`packages/server/src/config/env.ts`)

`EnvSchema`에 유량 상한 5필드를 추가한다(모두 `z.coerce.number().int().min(1)` fail-fast — `WS_MAX_*` 관례 미러, 미설정 부팅을 막지 않으면서 잘못된 값 0은 즉시 거부).

| 필드 | 기본값 | 역할 |
|------|--------|------|
| `WS_MSG_RATE_CAPACITY` | 20 | 연결당 버스트 허용 토큰 수. 사람 입력(피크 1~3 cmd/s)엔 넉넉하되 flood(수백/s)는 즉시 포착. |
| `WS_MSG_RATE_REFILL_PER_SEC` | 10 | 연결당 초당 리필(지속율). 사람의 지속 입력율을 넉넉히 덮되 flood는 못 따라오는 값. |
| `WS_MSG_RATE_ACCOUNT_CAPACITY` | 40 | 계정당 버스트 토큰 수. 계정당 5연결(정원) 하에 다중 탭 정상 사용은 허용하되 다중 연결 flood의 집계를 잡는 값. |
| `WS_MSG_RATE_ACCOUNT_REFILL_PER_SEC` | 20 | 계정당 초당 리필. 연결 지속율(10)의 다중 연결 합을 흡수하되 계정 차원 flood는 억제. |
| `WS_MSG_RATE_MAX_VIOLATIONS` | 10 | 연속 위반 종료 임계. 일시 버스트엔 여유를 주되 지속 flooder는 빠르게 초과해 graceful close. |

`min(1)`은 다섯 값 모두 load-bearing이다 — capacity가 0이면 어떤 프레임도 통과 못 한다.

## 동작

### 회계 단위 — 연결 + 계정 AND

프레임 하나는 연결 버킷과 계정 버킷을 **모두** 통과해야 accept된다(이슈 #64 "계정·연결별"에 충실). `check(now)`는 각 버킷을 자체 경과로 먼저 리필한 뒤, 둘 다 토큰이 있을 때만 각각 1개씩 소비한다(정원 check-then-increment 원자성 미러). 한쪽이라도 부족하면 어느 쪽도 소비하지 않아 부분 소비를 막는다. 정원(`connectionQuota`)이 계정당 연결 수(5)만 상한하므로 명시적 계정율 게이트가 별도로 필요하다.

토큰 버킷 알고리즘은 버스트 허용 + 평균율 제어를 함께 준다 — MUD 명령 패턴(가끔 버스트, 평소 저율)에 적합하고, 주입 clock으로 fake-clock 결정적 검증이 쉽다(슬라이딩 윈도우는 타임스탬프 배열 보관 비용·윈도우 경계 버스트 허점).

### arm 시점 — socket-open

유량 제한기는 **socket-open 시점**에 arm한다(`deadline` 관례 미러). handshake 완료가 아니다 — 인증 게이트를 통과한 pre-handshake 창(open → `system:ready`)의 flood도 커버 대상이다(핸드셰이크 완료를 기다리면 그 사이 flood가 무제한이다). `account`는 `preValidation` 게이트가 non-null을 보장하지만(인증 실패면 upgrade 자체가 차단) `strictNullChecks` 하에서 여전히 nullable이라, `releaseQuota`와 같은 방어적 가드로 `accountId`를 좁혀 한 번만 읽어 상수로 고정하고 close 리스너가 그 캡처값을 쓴다.

### 계정 버킷 소유·정리 — refCount + delete-at-zero

계정 버킷은 연결 간 공유 상태다. `createConnection`이 계정 엔트리 refCount를 올리고, close 리스너가 `releaseAccount`로 내려 0 도달 시 Map 엔트리를 삭제해 churn 계정의 Map 누적을 막는다. ws `'close'`가 2회 이상 발화할 수 있어(그래서 `releaseQuota`도 `releaseOnce`다) `rateReleased` once-guard 플래그가 load-bearing이다 — 가드가 없으면 `releaseAccount`가 이중 감소해 refCount를 조기에 0으로 만들어 살아 있는 형제 연결의 계정 엔트리를 지운다(계정 차원 상한 우회).

### 메시지 게이트 — drop / 경고 / 종료

message 핸들러 최상단, `JSON.parse` **앞**에 게이트를 둔다. 공격이 파싱·dispatch CPU 소진이므로 파싱 비용을 치르기 전에 초과분을 버려야 방어가 성립한다(파싱 뒤에 두면 이미 CPU를 쓴 뒤라 무의미 — `maxPayload`와 동형 논리).

```
socket.on('message', (data) => {
  const verdict = ctx.rateLimiter?.check(performance.now())   // 연결 + 계정 AND
  if (verdict !== undefined && verdict !== 'accept') {
    if (verdict === 'drop-warn') safeSend(socket, { type:'error', code:'rate_limited', message })  // 엣지 1회
    if (ctx.rateLimiter?.shouldTerminate() && socket.readyState === socket.OPEN) socket.close()     // 지속 초과 종료
    return   // parse·dispatch·idle 재-arm 우회
  }
  JSON.parse(...)   // 기존 경로 (parse → handshake → dispatch)
})
```

- **clock**: `performance.now()`(단조)를 쓴다. 코어 refill이 `now`의 단조 비감소를 가정하므로, NTP 보정으로 역행할 수 있는 `Date.now()` 대신 단조 클록을 공급해 역방향 점프가 유발하는 정상 사용자 spurious drop을 막는다.
- **경고 억제(anti-amplification)**: `drop-warn`(연속 폐기 구간의 첫 폐기)에만 `error{code:'rate_limited'}`를 1회 전송한다. 이후 연속 `drop`은 침묵해 경고가 그 자체로 아웃바운드 증폭이 되는 것을 막는다. 코어가 위반 카운터를 소유해 warn-edge를 계산하고 플러그인은 verdict만 소비한다. `accept`는 위반 카운터를 0으로 리셋하므로 일시 버스트는 다시 경고 자격을 얻는다.
- **idle 재-arm 우회**: drop은 핸들러 최상단 early-return이라 아래 dispatch handled 경로의 `ctx.idle?.arm()`을 구조적으로 우회한다 — 이것이 "drop된 프레임은 idle 타이머를 재-arm하지 않는다"의 메커니즘이다(flood가 유휴 종료를 앞당긴다).
- **종료**: 연속 위반이 `maxViolations`를 넘으면 소켓을 graceful close한다(`shouldTerminate()`가 코어 소유 위반 카운터로 판정). 이미 닫힌 소켓 재close를 막기 위해 `readyState === OPEN`을 함께 확인한다.

## 제약사항

- **미인증(pre-auth) 연결 방어는 범위 밖** — upgrade 전 게이트(Origin 403·세션 쿠키 401)는 [`ws-resource-guard.md`](ws-resource-guard.md)/[`auth-session.md`](auth-session.md) 담당. 이 문서는 인증 통과 후 인바운드율만 다룬다.
- **아웃바운드 속도 제한은 범위 밖** — 서버→클라 전송은 backpressure([`ws-resource-guard.md`](ws-resource-guard.md))가 담당.
- **연결 수 상한은 범위 밖** — `connectionQuota`([`ws-resource-guard.md`](ws-resource-guard.md)) 담당.
- **명령별 차등 비용(가중 토큰) 없음** — 모든 프레임을 토큰 1개로 균일 계수. 명령별 가중치는 후속.
- **분산·다중 프로세스 계정 회계 없음** — 단일 프로세스 in-memory 회계(ADR #14 D1 단일프로세스 결정 일관). Redis 등 외부 저장은 후순위.
- **결정적 테스트** — fake clock 주입 + 결정적 프레임 주입으로 상한 초과 시 drop·종료를 확인한다(부하 테스트 아님).

## 관련 문서

- [`transport-protocol.md`](transport-protocol.md) — 유량 게이트가 얹히는 message 처리 파이프라인·`errorCodeSchema` 계약 정본.
- [`ws-resource-guard.md`](ws-resource-guard.md) — 형제 방어 계층(연결 정원 + 아웃바운드 backpressure) 정본.
- [`auth-session.md`](auth-session.md) — arm 대상이 되는 인증된 연결의 게이트 정본.
- 이슈 #64(본 토픽), #54(선행: 연결 정원 + backpressure). ADR #14(D1 단일프로세스).
