# 재접속 시 write-behind pending 스냅샷 정합성: Research Report
*Generated: 2026-08-18 | Sources: 57 unique (8 deep-read) | Adapters: [adapter-exa, adapter-firecrawl] | Failed: ⚠️ adapter-firecrawl: 5개 서브질문 중 2건(Q1·Q4) 무응답*

## Executive Summary

이 문제는 write-behind 캐시의 알려진 실패 모드이고, 업계는 이미 이름을 붙여 다루고 있다. 핵심 명제는 **"캐시가 진실의 원천인 동안에는 저장소를 다시 읽으면 안 된다"**이다. Meta는 같은 형상(캐시 fill 응답과 무효화 이벤트의 경쟁)을 TAO에서 수년간 다뤘고, 해법은 **버전 필드를 통한 충돌 해소** — "오래된 데이터가 새 데이터를 덮어써서는 안 된다"였다 ([Meta Engineering](https://engineering.fb.com/2022/06/08/core-infra/cache-made-consistent/)). 다만 Meta는 그 위에 함정 하나를 더 지적한다: 버전을 가진 캐시 엔트리가 **evict되면 최신 데이터에 대한 지식 자체가 사라진다**. 본 토픽의 `release(id)`가 정확히 그 evict다.

가장 값진 발견은 **두 write의 순서가 손실 방향을 결정한다는 것이 15년 된 게임 서버 상식**이라는 점이다. gamedev.stackexchange의 채택 답변은 거래 시나리오로 이를 명시한다 — "'받는 쪽에 아이템 추가'와 '보내는 쪽에서 아이템 차감' 두 명령 중 첫 번째 뒤·두 번째 전에 실패하면 **아이템 복제**가 생긴다. 순서를 뒤집으면 **아이템 소실**이 생긴다" ([gamedev.SE](https://gamedev.stackexchange.com/questions/19338/how-often-to-save-players-state-in-persistent-online-games)). #120이 `markCharacterDirty` → `markObjectDeleted` 순서를 고른 근거와 정확히 같은 추론이고, 같은 답변이 이어서 **"서로 의존하는 연속 명령은 함께 저장돼야 한다"**고 못박는다.

해소 방향 선택에는 선례가 갈린다. **flush-on-disconnect**(방향 a)는 TrinityCore가 실제로 채택한 형태에 가깝고, 재접속 시 **저장소를 다시 읽지 않고 살아 있는 세션 객체를 새 세션으로 옮긴다** ([TrinityCore#21432](https://github.com/TrinityCore/TrinityCore/pull/21432)). **pending 우선 채택**(방향 b)은 CasCache가 "느린 writer가 3초 전에 조용히 덮어쓴 값을 주지 않는다 — 값이 최신임을 증명할 수 없으면 hit이 아니라 **miss로 취급한다**"는 규칙으로 구현한다 ([CasCache](https://github.com/unkn0wn-root/cascache)). 후자의 최소 형태는 **모노토닉 시퀀스 가드**이고, "논리 리소스당 카운터를 두고, 응답이 최신 발급분보다 오래됐으면 버린다"가 정석이다 ([Frontend Cache](https://frontendcache.com/cache-invalidation-server-synchronization/concurrency-and-race-conditions/)).

증상은 여러 상용 게임에서 그대로 재현된 바 있다 — Project Zomboid 42.13.1의 "접속 종료 때마다 캐릭터 데이터가 이전 시점으로 되돌아간다" ([The Indie Stone](https://theindiestone.com/forums/topic/90611-42131-players-save-is-reverted-to-last-save-state-whenever-he-disconnects/)), Minecraft 서버의 "갑자기 연결이 끊기면 신규 플레이어 상태로 리셋된다" ([Minecraft Forum](https://www.minecraftforum.net/forums/support/server-support-and/2950936-player-data-being-reset-to-the-start)). 즉 이 결함은 **미검출로 프로덕션에 나가는 부류**이며 사용자에게는 데이터 손실과 구분되지 않는다.

## 1. 문제의 정체 — write-behind에서 캐시는 진실의 원천이다

write-behind는 캐시에만 쓰고 즉시 성공을 응답한 뒤 백그라운드가 DB에 동기화한다. 대가는 명시적이다 — **"동기화 창 안에서 캐시가 사실상 system of record가 된다"** ([Redis Patterns](https://redis.antirez.com/fundamental/write-behind.html)). 그리고 DB는 캐시보다 뒤처지므로 **"DB에 직접 질의하면 stale 데이터가 돌아올 수 있다"**고 같은 문서가 경고한다.

본 토픽의 결함은 이 경고의 문자 그대로의 실현이다. `hydrate`가 `characterRepo.findById`로 DB를 직접 읽는데, 그 시점의 DB는 정의상 stale하다.

**write coalescing과 LWW의 대가도 문서화돼 있다.** 같은 키에 대한 반복 write는 dirty map에서 값만 덮어쓰며 접히고, 이 last-write-wins 합침은 카운터·리더보드에 유용하다. 다만 techinterview의 LLD 문서는 **"코얼레싱 의미론은 호출자에게 문서화돼야 한다 — 중간 값은 절대 영속되지 않는다"**고 단서를 단다 ([techinterview](https://www.techinterview.org/post/3233469260/lld-write-behind-cache/)). 본 토픽에서 stale 재읽기가 LWW 승자가 되는 것은 이 의미론이 **"나중 write가 더 새롭다"는 가정** 위에 서 있는데 재읽기가 그 가정을 깨기 때문이다.

techinterview는 flush 시점 충돌 검출도 제시한다 — write 시점에 `version`/`updated_at`을 함께 저장하고, flush에서 **낙관적 잠금 UPDATE(기대 버전 WHERE 절)**를 쓴다. 0행 갱신이면 동시 수정으로 보고 충돌 처리 전략을 고른다.

> **적용 판단**: 이 낙관적 잠금은 *외부 writer*와의 충돌을 잡는 장치다. 본 토픽의 충돌은 **같은 프로세스 안**에서 stale 재읽기가 만드는 것이라, DB 레벨 버전 가드보다 **재읽기 자체를 막는 쪽**이 더 직접적이다.

## 2. Meta TAO — 버전 가드와 "evict가 지식을 지운다"는 함정

Meta는 TAO의 캐시 정합성을 six nines에서 ten nines까지 끌어올린 과정을 공개했다. 도입부 사례가 본 토픽과 구조적으로 동일하다 — 캐시가 DB에서 `x=42`를 채우는 중에 누군가 `x=43`으로 바꾸고, 무효화 이벤트가 먼저 도착해 43을 넣은 뒤, **뒤늦게 도착한 fill 응답 `x=42`가 43을 덮는다.** 결과는 DB=43, 캐시=42로 무기한 어긋난다 ([Meta Engineering](https://engineering.fb.com/2022/06/08/core-infra/cache-made-consistent/)).

Meta가 제시한 해법과 그 한계가 둘 다 중요하다.

- **해법**: 버전 필드를 유지해 충돌 해소를 수행한다 — *"오래된 데이터가 새 데이터를 절대 덮어쓰면 안 된다."*
- **한계**: *"그런데 `x=43 @version=2` 캐시 엔트리가 `x=42`가 도착하기 전에 **evict되면**? 그 경우 캐시 호스트는 최신 데이터에 대한 지식을 잃는다."*

이 한계가 본 토픽에 직접 적용된다. `onSessionEnd`의 `release(id)`가 라이브 엔트리를 제거하는 순간이 곧 evict이고, 그 뒤의 `hydrate`에는 "무엇이 더 새로운지" 판단할 근거가 남지 않는다. **버전 가드만 라이브 레지스트리에 얹는 해법은 release가 그 버전을 함께 지우면 무력화된다** — 가드는 `release`보다 오래 사는 곳(DirtyTracker)에 있어야 한다.

Meta는 또 하나를 짚는다. 동적 캐시는 **읽기(fill) 경로와 쓰기(무효화) 경로 양쪽에서 데이터가 변한다**는 점이 race condition의 근원이라는 것이다. 본 토픽의 `hydrate`(읽기)와 `markCharacterDirty`(쓰기)가 같은 `characters:<id>` 키를 건드리는 구조가 정확히 이 형상이다.

Redis도 캐시 드리프트의 원인을 셋으로 정리하며 같은 지점을 든다 — TTL 창, **캐시와 DB 사이의 write-ordering 경쟁**, 여러 앱 인스턴스의 캐시 fill 충돌 ([Redis](https://redis.io/blog/cache-consistency-strategies/)).

## 3. 다중 키 부분 revert — 순서가 손실 방향을 정한다

**gamedev.stackexchange의 채택 답변(2011)이 본 토픽의 `study` 시나리오를 그대로 서술한다.** 명령 단위 저장 방식의 위험을 논하며:

> "서로 의존하는 연속 명령은 함께 저장돼야 한다. 그러지 않으면 명령 중간에 실패가 나서 하나만 저장될 수 있다. 두 플레이어가 거래해 '받는 쪽에 아이템 1 추가'와 '보내는 쪽에서 아이템 1 차감' 두 명령이 저장된다고 하자. 첫 명령 뒤·두 번째 명령 전에 실패가 나면 **아이템 복제**가 생긴다. **순서가 반대면 아이템 소실이 생긴다.**" ([gamedev.SE](https://gamedev.stackexchange.com/questions/19338/how-often-to-save-players-state-in-persistent-online-games))

#120 스펙 OQ1이 `markCharacterDirty`를 먼저 두기로 한 결정은 이 추론과 동형이다. 다만 인용문의 마지막 문장이 본 토픽에 대한 경고다 — **본 결함에서는 두 write가 모두 성공하는데도 "한쪽만 revert"되어 소실 방향이 실현된다.** 부분 커밋의 원인이 실패가 아니라 revert라는 점만 다르고 결과는 같다.

**아이템 복제 방지 선례가 강조하는 것은 원자성과 단일 권위다.** Bugnet은 "전송을 원자적으로 만들라(전송 시 **추가보다 제거를 먼저**), 이벤트 이중 발화를 막으라, 인벤토리를 **한 곳에서만 바뀌는 권위 상태**로 다루라"로 요약한다 ([Bugnet](https://bugnet.io/blog/how-to-fix-inventory-item-duplication-bug)). 고전적 복제 익스플로잇 목록에도 **"다른 캐릭터에게 거래한 뒤 거래한 계정을 먼저 접속 종료"**가 올라 있다 ([munique.net](https://munique.net/item-duplication-exploits/)) — 접속 종료가 영속 경계와 엮이는 순간이 공격 표면이라는 뜻이다.

**다중 키 원자성의 일반 해법은 transactional outbox다.** 업무 엔티티 갱신과 메시지 발행을 같은 트랜잭션에 넣고 별도 릴레이가 전달한다. 이득은 "2PC 없이도 DB 트랜잭션이 커밋될 때만 메시지가 전달됨이 보장"되고 **순서가 보존**된다는 것이다. 대가는 릴레이가 **메시지를 두 번 이상 발행할 수 있다**는 점이라 소비자 멱등성이 필요하다 ([microservices.io](https://microservices.io/patterns/data/transactional-outbox.html)).

> **적용 판단**: outbox는 본 토픽에 과하다. 두 write가 **같은 프로세스·같은 DirtyTracker·같은 flush**에 있어 전달 보장 문제가 아니라 **한쪽 키가 stale로 교체되는 문제**다. 다만 "업무 상태와 후속 작용을 같은 원자 단위에 넣는다"는 원리는 방향 (a)/(c)가 자연히 만족한다.

**게임 도메인의 멱등성 실무 표준도 확인된다.** PlayFab Economy v2는 인벤토리 write API 전체에 `IdempotencyId`를 두고 14일간 보관해 같은 ID의 재요청에 원 결과를 돌려준다. 별도로 ETag 기반 낙관적 동시성 제어를 제공해 **"마지막 읽기 이후 인벤토리가 변하지 않은 경우에만 write가 성공"**하게 한다 ([PlayFab](https://learn.microsoft.com/en-us/gaming/playfab/economy-monetization/economy-v2/tutorials/idempotent-transactions-and-retries)).

## 4. 해소 방향별 선례

### (a) flush-on-disconnect / 세션 객체 이전 — TrinityCore

TrinityCore는 강제 접속 종료 시 플레이어를 **1분간 월드에 남긴다**. 그 안에 재접속하면 **기존 세션을 그대로 받는다**. 리뷰 코멘트가 구현의 핵심을 적는다 — *"`_player`를 옛 WorldSession에서 새 것으로 옮기기만 하면 된다"* ([TrinityCore#21432](https://github.com/TrinityCore/TrinityCore/pull/21432)).

이는 방향 (a)와 (c)의 혼합에 가깝다. 저장소를 다시 읽지 않고 **라이브 객체를 재사용**하므로 stale 재읽기 자체가 발생하지 않는다.

> **본 토픽 대비**: 이미 `hydrate`가 "재접속은 재로드하지 않는다(D-G 1)"로 **등록된 엔트리는 `findById` 없이 반환**한다. 문제는 grace 만료 후 `release`된 뒤의 경로다. TrinityCore의 1분 타이머는 본 토픽의 `WS_RECONNECT_GRACE_MS`(30초)와 같은 장치이며, 차이는 **grace 만료 시 flush 없이 release한다**는 점이다.

### (b) pending 우선 채택 / 증명 못 하면 miss — CasCache

CasCache는 목적을 이렇게 적는다 — *"캐시된 키가 항상 최신 상태를 반영하고, 느린 writer가 3초 전에 조용히 덮어쓴 값이 아니게 해야 한다면"*. 규칙은 단호하다: *"stale 데이터를 제공하지 않고, 늦은 write가 조용히 이기거나 덮어쓰게 두지 않는다. 값이 최신임을 **증명할 수 없으면 hit이 아니라 miss로 취급한다**"* ([CasCache](https://github.com/unkn0wn-root/cascache)).

최소 구현 형태는 모노토닉 시퀀스 가드다 — (1) 논리 리소스당 카운터를 두고(전역 카운터 금지), (2) 요청 시작 시 값을 캡처, (3) 응답 시 최신 발급분과 비교해 **오래된 것은 버리고**, (4) 수락된 시퀀스를 저장해 두 번째 늦은 응답도 막는다 ([Frontend Cache](https://frontendcache.com/cache-invalidation-server-synchronization/concurrency-and-race-conditions/)).

더 가벼운 변형으로 **타임스탬프 비교(staleness guard)**가 있다. 한 사례는 캘린더 동기화에서 "사용자가 제목을 수정했는데 계속 옛 제목으로 되돌아가는" 버그를 다뤘고, 원인은 **사용자 편집 이전 시점의 webhook 데이터가 로컬 레코드를 무조건 덮어쓴 것**이었다. 수정은 10줄짜리 타임스탬프 비교였다 ([Brandon Wie](https://brandonwie.dev/posts/updatedAt-staleness-guard)).

> **본 토픽 대비**: 증상 서술("수정했는데 계속 옛 값으로 되돌아간다")이 #124와 동일하다. 다만 §2의 Meta 함정이 적용된다 — 가드가 `release`와 함께 사라지는 곳에 있으면 안 된다.

### (c) 저장 정책 층위 — Hibernate NONSTRICT_READ_WRITE의 반례

Hibernate의 `NONSTRICT_READ_WRITE`는 캐시 엔트리를 **갱신하지 않고 무효화**하며, 무효화가 DB 트랜잭션과 동기화되지 않는다. 트랜잭션 완료 전후로 **두 번** 무효화해도 *"캐시와 DB가 어긋날 수 있는 아주 작은 시간 창이 여전히 남는다"* ([Vlad Mihalcea](https://vladmihalcea.com/how-does-hibernate-nonstrict_read_write-cacheconcurrencystrategy-work/)).

교훈은 **무효화 횟수를 늘리는 것으로는 창을 닫지 못한다**는 것이다. 본 토픽에서 "grace를 늘린다"나 "flush 주기를 줄인다"는 대응은 같은 부류이며 창을 좁힐 뿐 닫지 못한다.

## 5. grace period와 flush 주기의 결합

재접속 설계의 정석은 상태를 셋으로 나누는 것이다 — *connected · disconnected-but-reservable(grace 창) · left(grace 만료 또는 명시적 종료)*. 그리고 *"재접속 설계의 거의 모든 작업이 그 중간 상태에 관한 것이다 — 얼마나 지속되는지, 그동안 무엇을 열어 두는지, 누구를 다시 들여보내는지"* ([Crux](https://crux.supercraft.host/blog/player-reconnection-and-session-resumption/)).

본 토픽의 결함은 이 프레임으로 보면 **"그동안 무엇을 열어 두는지"의 답이 불완전한 것**이다. 라이브 엔트리는 열어 두지만 **영속 경계는 열어 두지 않는다** — grace가 만료되면 flush를 기다리지 않고 release한다.

저장 주기 자체에 대한 업계 조언은 두 극단의 절충이다. 명령마다 저장하면 서버 성능·디스크 I/O 부담과 큐 적체 위험이 있고, 주기 저장은 장애 시 **모든 활성 플레이어가 같은 시간만큼 되감긴다**는 성질을 갖는다 ([gamedev.SE](https://gamedev.stackexchange.com/questions/19338/how-often-to-save-players-state-in-persistent-online-games)). 후자의 "같은 만큼 되감긴다"는 성질이 중요하다 — **본 토픽의 결함은 이 균일성을 깨고 한 플레이어의 특정 키만 되감는다.**

세션 데이터에 대해 인메모리 캐시를 쓰는 제품군은 이 지점을 명시적 판매 포인트로 삼는다 ([Apache Ignite](https://ignite.apache.org/use-cases/session-management/)). Ignite의 write-behind는 flush 스레드가 모두 바쁘고 큐가 차면 **backpressure**로 대응한다 ([StackOverflow](https://stackoverflow.com/questions/47548547/ignite-write-behind-internals)) — 본 토픽의 `AsyncWriteQueue`가 단일 워커 FIFO인 것과 대비되는 설계 선택지다.

## 6. 프로덕션 사례 — 미검출로 나가는 결함

- **Project Zomboid 42.13.1** — *"친구의 캐릭터 데이터가 서버를 떠날 때마다 저장되지 않고 이전 시점으로 되돌아간다"* ([The Indie Stone](https://theindiestone.com/forums/topic/90611-42131-players-save-is-reverted-to-last-save-state-whenever-he-disconnects/)). 증상 서술이 #124와 사실상 동일하다.
- **Minecraft 서버** — *"플레이어가 갑자기 연결이 끊기면 신규 플레이어 상태로 리셋되는 경우가 있다"* ([Minecraft Forum](https://www.minecraftforum.net/forums/support/server-support-and/2950936-player-data-being-reset-to-the-start)).

두 사례 모두 **정상 종료가 아니라 비정상 종료 경로**에서 발생한다. 회귀 테스트가 정상 로그아웃만 덮으면 잡히지 않는 부류이며, 본 토픽의 회귀 테스트가 grace 만료 경로를 명시적으로 덮어야 하는 근거다.

Meta의 표현이 심각도를 요약한다 — *"어떤 경우 캐시 불일치는 데이터베이스의 데이터 손실만큼 나쁘다. 사용자 관점에서는 데이터 손실과 구분조차 되지 않는다"* ([Meta Engineering](https://engineering.fb.com/2022/06/08/core-infra/cache-made-consistent/)).

## Key Takeaways

- **"저장소를 다시 읽지 않는다"가 1차 원칙이다.** write-behind에서 캐시는 동기화 창 동안 system of record이고, DB 직접 질의는 정의상 stale하다. 방향 (a)·(b)·(c) 중 무엇을 고르든 이 원칙을 만족해야 한다.
- **버전/시퀀스 가드를 `release`보다 오래 사는 곳에 둔다.** Meta가 명시한 함정 — 버전을 가진 엔트리가 evict되면 최신성 판단 근거 자체가 사라진다. 라이브 레지스트리가 아니라 DirtyTracker 쪽에 가드가 있어야 한다.
- **"증명할 수 없으면 miss로 취급"이 안전한 기본값이다.** CasCache의 규칙. 방향 (b)를 택한다면 hydrate가 pending을 *조회*하는 데 그치지 말고, 최신성을 확정하지 못할 때의 동작을 명시해야 한다.
- **두 write의 순서 선택은 게임 서버의 오래된 상식이고, 본 결함은 그 상식이 전제한 실패 모델(부분 *실패*) 밖에 있다.** 여기서는 두 write가 모두 성공하면서 한쪽만 revert된다. #120 OQ1의 순서 결정은 유효하되 보호 범위가 부족하다.
- **창을 좁히는 대응은 창을 닫지 못한다.** Hibernate NONSTRICT_READ_WRITE가 무효화를 두 번 해도 창이 남는 반례. grace 연장·flush 주기 단축은 해법이 아니다.
- **회귀 테스트는 비정상 종료 경로를 명시적으로 덮어야 한다.** Project Zomboid·Minecraft 사례 모두 정상 로그아웃이 아니라 abrupt disconnect에서 발생했다.
- **outbox·2PC는 이 문제에 과하다.** 전달 보장이 아니라 같은 프로세스 내 키 교체 문제다. 다만 멱등성(PlayFab `IdempotencyId`)과 낙관적 동시성(ETag)은 재시도 설계에 참고할 만하다.

## Sources

1. [Cache made consistent — Meta Engineering](https://engineering.fb.com/2022/06/08/core-infra/cache-made-consistent/) — TAO의 캐시 무효화 경쟁, 버전 기반 충돌 해소와 evict 함정
2. [Write-Behind (Write-Back) Caching Pattern — Redis Patterns](https://redis.antirez.com/fundamental/write-behind.html) — 동기화 창 동안 캐시가 system of record, DB 직접 질의는 stale
3. [How often to save player's state in persistent online games? — gamedev.SE](https://gamedev.stackexchange.com/questions/19338/how-often-to-save-players-state-in-persistent-online-games) — 두 write 순서가 복제/소실 방향을 결정, 의존 명령은 함께 저장
4. [Write-Behind Cache Low-Level Design — techinterview](https://www.techinterview.org/post/3233469260/lld-write-behind-cache/) — LWW 코얼레싱 의미론, flush 시 낙관적 잠금 충돌 검출, WAL 복구
5. [How does Hibernate NONSTRICT_READ_WRITE work — Vlad Mihalcea](https://vladmihalcea.com/how-does-hibernate-nonstrict_read_write-cacheconcurrencystrategy-work/) — 무효화 2회로도 남는 드리프트 창(반례)
6. [Pattern: Transactional outbox — microservices.io](https://microservices.io/patterns/data/transactional-outbox.html) — 다중 키 원자성 일반 해법과 그 대가(중복 전달)
7. [Idempotent transactions and retry patterns in Economy v2 — PlayFab](https://learn.microsoft.com/en-us/gaming/playfab/economy-monetization/economy-v2/tutorials/idempotent-transactions-and-retries) — 게임 인벤토리 멱등성·ETag 낙관적 동시성 실무 표준
8. [Core/Player: fix for Player Instant Logout — TrinityCore#21432](https://github.com/TrinityCore/TrinityCore/pull/21432) — 1분 잔류 타이머 + 세션 객체 이전(재로드 없음)
9. [unkn0wn-root/cascache](https://github.com/unkn0wn-root/cascache) — "최신임을 증명 못 하면 miss로 취급" 규칙
10. [Concurrency & Race Conditions — Frontend Cache](https://frontendcache.com/cache-invalidation-server-synchronization/concurrency-and-race-conditions/) — 리소스별 모노토닉 시퀀스 가드 4단계
11. [updatedAt Staleness Guard — Brandon Wie](https://brandonwie.dev/posts/updatedAt-staleness-guard) — 타임스탬프 비교로 stale 덮어쓰기 차단(동일 증상 사례)
12. [Player Reconnection & Session Resumption — Crux](https://crux.supercraft.host/blog/player-reconnection-and-session-resumption/) — connected/reservable/left 3상태 모델
13. [Cache Consistency: Strategies to Keep Data Fresh — Redis](https://redis.io/blog/cache-consistency-strategies/) — 캐시 드리프트 3대 원인
14. [Players Save is reverted to last save state — The Indie Stone](https://theindiestone.com/forums/topic/90611-42131-players-save-is-reverted-to-last-save-state-whenever-he-disconnects/) — Project Zomboid 동일 증상 프로덕션 사례
15. [Player data being reset to the "start" — Minecraft Forum](https://www.minecraftforum.net/forums/support/server-support-and/2950936-player-data-being-reset-to-the-start) — abrupt disconnect 시 상태 리셋 사례
16. [How to Fix an Inventory Item Duplication Bug — Bugnet](https://bugnet.io/blog/how-to-fix-inventory-item-duplication-bug) — 원자적 전송·단일 권위 상태 원칙
17. [On item duplication exploits and how to prevent them — munique.net](https://munique.net/item-duplication-exploits/) — 접속 종료를 이용한 복제 익스플로잇 유형
18. [Session Management and Caching at Scale — Apache Ignite](https://ignite.apache.org/use-cases/session-management/) — 세션 캐시 정합성 포지셔닝
19. [Ignite Write Behind Internals — StackOverflow](https://stackoverflow.com/questions/47548547/ignite-write-behind-internals) — write-behind backpressure 설계

## Methodology

5개 서브질문에 대해 10개 질의를 실행했다(어댑터당 1회씩). 사용 어댑터: adapter-exa(5/5 성공), adapter-firecrawl(3/5 성공). 실패: ⚠️ adapter-firecrawl — Q1(write-back dirty 스냅샷 stale 재읽기)·Q4(LWW stale 스냅샷 덮어쓰기) 2건에서 빈 응답. 해당 서브질문은 adapter-exa 결과만으로 커버했다.

서브질문: (1) write-back 캐시의 dirty 엔트리가 evict 후 재로드될 때의 stale read 정합성, (2) 게임 서버의 접속 종료 시 상태 저장·linkdead grace·재접속 복원, (3) 다중 키 부분 커밋으로 인한 아이템 복제/소실과 outbox·멱등성 대응, (4) LWW 코얼레싱에서 stale 스냅샷이 승자가 되는 실패 모드와 버전 가드, (5) grace period와 flush 주기 결합의 실패 창.

수집 소스 64건 → URL 정규화 후 고유 57건. 그중 8건을 adapter-exa `/contents`로 전문 정독하고 나머지는 스니펫으로 훑었다.

**한계** — 서브질문 5(grace period와 flush 주기의 정량적 결합 기준)에 대해 **수치화된 권고를 제시하는 1차 자료를 찾지 못했다.** TrinityCore의 1분 타이머는 단일 구현 사례이지 일반 기준이 아니다. 본 보고서는 "창을 좁히는 것은 해법이 아니다"까지만 근거를 갖추었고, 구체적 grace/flush 값 선택은 저장소 내부 판단에 맡긴다.
