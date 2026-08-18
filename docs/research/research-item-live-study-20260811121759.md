# 게임 서버 아이템 인스턴스 라이브 상태 관리: Research Report
*Generated: 2026-08-11 | Sources: 60 unique (8 deep-read) | Adapters: [adapter-exa, adapter-firecrawl] | Failed: none*

## Executive Summary

인메모리 권위 상태 + DB write-behind는 MMO 아키텍처의 표준 선택이며, "DB는 진실의 원천이 아니다"는 명제가 명시적으로 문서화돼 있다 ([PRDeving](https://prdeving.wordpress.com/2023/09/29/mmo-architecture-source-of-truth-dataflows-i-o-bottlenecks-and-how-to-solve-them/)). 템플릿/인스턴스 분리 역시 가상 세계의 보편 구조로, 사실상 모든 가상 세계가 **읽기 전용 템플릿 저장소 + 읽기·쓰기 인스턴스 저장소** 최소 2개를 유지한다 ([Raph Koster](https://www.raphkoster.com/2021/10/07/digital-objects-how-virtual-worlds-work-part-3/)). 즉 본 토픽이 세우려는 형상(템플릿 인덱스 인메모리 상주 + 인스턴스 문서 컬렉션)은 관행에 부합한다.

가장 값진 발견은 **동기 핸들러를 async로 바꿀 때의 구체적 실패 모드**다. `ox_inventory` PR #1950은 아이템 이동 경로에서 "카운트 변형 → **yield** → dirty 플래그 세팅" 순서 때문에 접속 종료가 그 사이에 끼어들어 **아이템이 복제되는** 버그를 문서화했고, 수정은 yield를 임계 구간 밖으로 밀어내는 것이었다 ([ox_inventory#1950](https://github.com/overextended/ox_inventory/pull/1950)). 이는 dirty-flag 기반 write-behind를 쓰는 모든 시스템의 공통 함정이다 ([Redis Patterns](https://redis.antirez.com/fundamental/write-behind.html)).

async 전환 비용에 관해서는 두 갈래 조언이 대립하지 않고 층이 다르다. 인터페이스 차원에서는 **동기/비동기 핸들러를 한 계약으로 통일**하는 편이 낫다는 주장이 설득력 있게 제시되고 ([Software Engineering SE](https://softwareengineering.stackexchange.com/questions/418036/combining-synchronous-and-asynchronous-commands-when-using-the-command-pattern)), 실행 차원에서는 async 전환이 "주로 시그니처가 깨지는" 파급 작업이며 작은 PR 다수로 쪼개야 한다고 경고한다 ([Start Debugging](https://startdebugging.net/2026/07/migrate-from-blocking-result-and-wait-calls-to-async-all-the-way-up-in-csharp/)).

## 1. 인메모리 권위 상태와 write-behind 영속화

**DB를 진실의 원천으로 두면 산술이 무너진다.** PRDeving은 1000명 플레이어가 초당 1회 행동을 보내는 것만으로 초당 N회 쓰기가 발생하며, 여기에 경험치·타격·채팅이 얹힌다고 지적한다. 결론은 명시적이다 — "온라인 게임에서 세계 상태의 진실의 원천은 인메모리 월드 상태이지 데이터베이스가 아니다. DB는 진실의 원천이 아니라 **영속화 매체**로 간주한다" ([PRDeving](https://prdeving.wordpress.com/2023/09/29/mmo-architecture-source-of-truth-dataflows-i-o-bottlenecks-and-how-to-solve-them/)).

> 이 명제는 본 저장소의 `docs/specs/save-policy.md`가 이미 채택한 입장과 같다. 리서치는 새 방향을 제시하기보다 **기존 결정을 외부 사례로 확증**한다.

**write-behind의 동작과 대가.** 애플리케이션은 캐시에만 쓰고 즉시 성공을 응답받으며, 별도 백그라운드 프로세스가 주기적으로 DB에 동기화한다. 이득은 쓰기 지연 최소화와 **write coalescing**(같은 키에 대한 1000회 갱신이 최종값 1회 쓰기로 접힘)이다. 대가는 동기화 창 안에서의 **데이터 손실 위험**과 DB의 지연된 일관성이다 ([Redis Patterns](https://redis.antirez.com/fundamental/write-behind.html)).

동기화 프로세스의 표준 형태도 명시돼 있다 — dirty 플래그나 타임스탬프로 변경된 키를 스캔하고, DB에 쓰고, 동기화됨으로 표시한다. 그리고 **실패를 우아하게 처리해야 한다: DB 쓰기가 실패하면 해당 키는 재시도 대상으로 표시된 채 남아야 한다** ([Redis Patterns](https://redis.antirez.com/fundamental/write-behind.html)).

Oracle Coherence와 Red Hat Data Grid도 read-through/write-through/write-behind를 1급 영속화 모드로 문서화하며, write-behind를 지연 쓰기 큐로 규정한다 ([Oracle Coherence](https://docs.oracle.com/cd/E13924_01/coh.340/e13819/readthrough.htm), [Red Hat Data Grid](https://docs.redhat.com/en/documentation/red_hat_data_grid/7.3/html/red_hat_data_grid_user_guide/persistence)).

## 2. 템플릿/인스턴스 분리 — 관행과 필드 분할 기준

**최소 2개 저장소가 표준이다.** Raph Koster는 가상 세계 객체를 "쿠키 커터(템플릿)와 쿠키(인스턴스)"로 설명하며, 사실상 모든 가상 세계가 두 개의 저장소를 유지한다고 쓴다 — (1) **읽기 전용**이며 개발자만 채우는 템플릿 저장소, (2) **읽기·쓰기**이며 변경이 영속되는 런타임 인스턴스 저장소 ([Raph Koster](https://www.raphkoster.com/2021/10/07/digital-objects-how-virtual-worlds-work-part-3/)).

**필드 분할의 판정 기준도 같은 글이 제시한다.** "변하지 않는 필드는 인스턴스에 있을 필요가 아예 없다 — 모든 오크마다 '오크'라는 이름을 저장할 필요 없이 템플릿의 이름을 쓰면 된다. 반면 데이터가 변할 수 있다면 인스턴스에 저장해야 한다. 템플릿의 데이터는 플레이어가 변경할 수 없고(immutable), 인스턴스의 데이터는 변경 가능하다(modifiable)" ([Raph Koster](https://www.raphkoster.com/2021/10/07/digital-objects-how-virtual-worlds-work-part-3/)).

같은 글은 텍스트 MUD가 수십 년간 템플릿 데이터를 공유해 왔다고 언급하며, 공유가 지나쳐 게임 구분이 어려워진 현상을 "stock mud syndrome"이라 부른다 — 본 프로젝트처럼 MUD 계보를 잇는 경우 템플릿 저장소가 정본 콘텐츠 자산임을 시사한다.

**패턴 이름의 구분.** Game Programming Patterns는 Flyweight와 Type Object를 갈라 놓는다. 둘 다 객체 상태 일부를 여러 인스턴스가 공유하는 다른 객체에 위임하지만 **의도가 다르다** — Type Object는 "타입"을 자체 객체 모델로 끌어올려 정의해야 할 클래스 수를 줄이는 것이 목적이고 메모리 공유는 부산물인 반면, **Flyweight는 순수하게 효율이 목적**이다 ([Game Programming Patterns](https://gameprogrammingpatterns.com/flyweight.html)).

> **추론(출처 없음)**: 본 토픽의 `ObjectTemplate`은 674종 남짓의 콘텐츠 정의를 데이터로 다루는 것이므로 의도상 Flyweight보다 **Type Object**에 가깝다. 메모리 절감은 부수 효과다.

**실물 구현 참조.** OpenMU(MU Online 서버 재구현, C#)의 `Item` 엔티티는 이 분할을 그대로 보여준다 — 인스턴스는 `Definition`(템플릿) 참조를 들고, 나머지는 전부 인스턴스별 가변 상태다: `ItemSlot`, `Durability`, `Level`, `HasSkill`, `ItemOptions`, `SocketCount`, `StorePrice`, `PetExperience`. 표시 이름조차 인스턴스가 갖지 않고 `Definition.GetNameForLevel(Level)`로 템플릿에서 파생한다 ([OpenMU Item.cs](https://github.com/MUnique/OpenMU/blob/master/src/DataModel/Entities/Item.cs)).

Unity 커뮤니티에서도 "아이템 정의 데이터와 인스턴스 데이터 분리"가 반복 질문으로 다뤄지며 동일 결론에 도달한다 ([Unity Discussions](https://discussions.unity.com/t/separating-item-definition-data-from-item-instance-data/752786)).

## 3. 동기 핸들러의 async 전환 — 통일된 계약 vs 임계 구간 보호

### 3.1 인터페이스 차원: 통일이 낫다

동기 명령과 비동기 명령을 같은 디스패처로 다루는 문제에 대한 채택 답변은, 소비자가 문자열을 파싱하지 않는 이상 어떤 명령이 동기인지 비동기인지 알 수 없으므로 `ISyncCommand`/`IAsyncCommand`로 나누는 것은 말이 되지 않는다고 지적한다. 어떤 명령인지 결정하는 것은 팩토리의 일이고, 동기·비동기 여부를 정하는 것은 명령 자신의 일이며, **소비자는 그 판단에 관여하지 않는다**. 동기 명령이 `Task.CompletedTask`를 반환하는 것이 어색하게 느껴지는 유일한 이유는 명명 관례(`Async` 접미사)일 뿐이다 ([Software Engineering SE](https://softwareengineering.stackexchange.com/questions/418036/combining-synchronous-and-asynchronous-commands-when-using-the-command-pattern)).

### 3.2 실행 차원: 시그니처 파급이 비용의 본체

async 전환은 찾아 바꾸기가 아니다. "**깨지는 것은 대부분 시그니처**다 — 블로킹을 멈추는 모든 메서드가 `Task`를 반환해야 하고, 그것이 인터페이스·생성자·`Dispose`·`lock` 블록·공개 API 표면으로 전파된다." 수십만 줄 규모 서비스에 1~3 스프린트를 잡고, **하나의 대형 PR이 아니라 여러 수직 슬라이스로** 진행하라고 권한다. 사전 준비 항목에 "작은 PR 다수를 허용하는 브랜치 전략 — 솔루션의 모든 시그니처를 바꾸는 400파일 PR은 리뷰되지 않는다"가 명시돼 있다 ([Start Debugging](https://startdebugging.net/2026/07/migrate-from-blocking-result-and-wait-calls-to-async-all-the-way-up-in-csharp/)).

전환을 **미룰 만한** 조건도 제시된다 — "한 번 실행하고 끝나는 CLI 도구 안의 블로킹 호출이면 미룰 가치가 있다." 뒤집으면 전환이 정당화되는 조건은 부하 상황의 스레드 풀 고갈이나 데드락 같은 **관측된 증상**이다 ([Start Debugging](https://startdebugging.net/2026/07/migrate-from-blocking-result-and-wait-calls-to-async-all-the-way-up-in-csharp/)).

> **주의(맥락 차이)**: 이 문서는 .NET 스레드 풀 모델을 전제한다. Node.js 단일 이벤트 루프에는 "스레드 풀 고갈" 항목이 그대로 적용되지 않는다. 이식 가능한 부분은 **시그니처 전파 비용과 PR 분할 전략**이다.

### 3.3 결정적 경고: yield가 임계 구간에 들어가면 아이템이 복제된다

`ox_inventory` PR #1950(2026-06 머지)은 본 토픽에 가장 직접적인 사례다. 플레이어 인벤토리에서 영속 컨테이너(stash·trunk·glovebox)로 아이템을 옮기는 도중 **약 50ms 창 안에 접속을 끊으면 스택이 복제**됐다 — 플레이어도 아이템을 유지하고 컨테이너도 영속화했다. 재현 가능했고 재접속 후에도 살아남았다 ([ox_inventory#1950](https://github.com/overextended/ox_inventory/pull/1950)).

근본 원인은 커밋 순서였다:

1. **라이브 카운트 변형** — `fromData.count -= n`, `toData.count += n`
2. **yield** — 훅 핸들이 닫히며 `Wait(50)`이 무조건 실행되어 코루틴이 정지
3. **dirty 플래그 세팅** — `changed = true`가 yield **이후**에 실행

스케줄러가 협조적이므로 다른 핸들러는 이 코루틴이 정지한 동안에만 실행된다. 2단계에서 접속이 끊기면 종료 경로는 `if not inv.datastore and inv.changed`로만 저장하는데 플레이어의 `changed`가 **아직 false**라 저장이 건너뛰어지고 차감(`-n`)이 버려진다. 코루틴은 재개되어 컨테이너만 `changed = true`로 표시하고 증가분(`+n`)을 영속화한다. 재접속 시 플레이어는 차감 전 카운트를 DB에서 로드한다. 순증 `+n`이 복제된다. PR은 **슬롯 락이 도움이 되지 않는다**는 점도 짚는다 — 락은 동시 스왑만 막고 접속 종료 경로는 막지 못한다 ([ox_inventory#1950](https://github.com/overextended/ox_inventory/pull/1950)).

수정은 두 갈래였다:

1. **근본 원인** — 사후 이벤트 지연을 스왑의 임계 구간 밖으로 밀어냄(`Wait(50)`을 별도 코루틴으로 이동). 그 결과 카운트 변형과 `changed` 커밋 사이에 **yield가 존재하지 않게** 됐다.
2. **심층 방어** — 접속을 끊는 플레이어의 인벤토리는 dirty 여부와 무관하게 항상 저장(`inv.changed or inv.player`). dirty 최적화는 컨테이너에만 남긴다.

후속 PR #1952의 제목이 "commit swapItems atomically so a yielding hook cannot dupe"인 점도 같은 방향을 가리킨다 ([ox_inventory#1950](https://github.com/overextended/ox_inventory/pull/1950)).

> **본 토픽에의 함의(추론)**: 명령 핸들러를 async로 만드는 것 자체는 위험하지 않다. 위험한 것은 **상태 변형과 `markDirty` 사이에 `await`가 끼는 것**이다. 인벤토리 조회 I/O를 명령 시점에 수행한다면, 그 `await`는 변형 **이전**에 완료돼야 하고 변형→`markDirty`는 동기 블록 하나로 묶여야 한다. 아울러 세션 종료 경로가 dirty 플래그와 무관하게 캐릭터 상태를 저장하는지도 별도로 점검할 항목이다.

## 4. 인벤토리 eager hydrate vs lazy 조회

이 축에 대해서는 **게임 서버 맥락의 직접적·정량적 비교 자료를 찾지 못했다**(Quality Rule 4: 공백 인정). 검색은 주로 ORM 맥락의 lazy/eager loading 논의로 수렴했으며, 그 결론은 "N+1 왕복을 피하려면 필요한 것을 미리 가져오되 쓰지 않을 것까지 가져오지 말라"는 일반론에 머문다 ([Stack Overflow](https://stackoverflow.com/questions/15778375/lazy-vs-eager-loading-performance-on-entity-framework), [r/dotnet](https://www.reddit.com/r/dotnet/comments/1f4qniz/lazy_loading_vs_eager_loading_which_is_best/)).

간접 증거는 있다:

- **로그인 시 인벤토리 로딩은 실측 병목이 될 수 있다.** Second Life 뷰어는 로그인 성능 개선을 위해 인벤토리를 비동기로 로드하는 변경을 추적하고 있다 ([secondlife/viewer#4972](https://github.com/secondlife/viewer/issues/4972)). 다만 이는 **클라이언트** 측 사례다.
- **컨테이너 아이템 수가 많아지면 지연이 발생한다**는 서버 측 이슈가 오픈소스 MUD 계열(Forgotten Server)에 보고돼 있다 ([otland/forgottenserver#1150](https://github.com/otland/forgottenserver/issues/1150)).
- **인메모리 상주 접근이 표준**이라는 §1의 명제는 eager 쪽에 무게를 싣는다 — 진실의 원천이 메모리라면 명령 시점마다 DB를 조회하는 것은 그 전제와 상충한다 ([PRDeving](https://prdeving.wordpress.com/2023/09/29/mmo-architecture-source-of-truth-dataflows-i-o-bottlenecks-and-how-to-solve-them/)).

> **추론(출처 없음, 낮은 확신)**: 위 세 갈래를 종합하면 세션 진입 시 hydrate해 라이브 상주시키는 쪽이 인메모리 권위 모델과 정합하고 §3.3의 yield 위험도 회피한다. 다만 "로그인 지연"이라는 반대급부가 실재하므로, 인벤토리 규모가 큰 캐릭터에 대한 측정 없이 단정할 수는 없다.

## Key Takeaways

- **인메모리 권위 + DB write-behind는 확증된 표준이다.** 기존 `save-policy.md` 입장을 바꿀 근거는 발견되지 않았다 ([PRDeving](https://prdeving.wordpress.com/2023/09/29/mmo-architecture-source-of-truth-dataflows-i-o-bottlenecks-and-how-to-solve-them/)).
- **템플릿=불변·읽기 전용, 인스턴스=가변·영속**이 필드 분할의 판정 기준이다. 변하지 않는 필드는 인스턴스에 두지 않는다 ([Raph Koster](https://www.raphkoster.com/2021/10/07/digital-objects-how-virtual-worlds-work-part-3/), [OpenMU](https://github.com/MUnique/OpenMU/blob/master/src/DataModel/Entities/Item.cs)).
- **가장 중요한 설계 제약: 상태 변형과 dirty 마킹 사이에 `await`를 두지 않는다.** 그 사이의 정지점이 접속 종료와 만나면 아이템 복제로 이어지며, 슬롯 락은 이를 막지 못한다 ([ox_inventory#1950](https://github.com/overextended/ox_inventory/pull/1950)).
- **심층 방어로 세션 종료 경로는 dirty 여부와 무관하게 저장**하는 것이 검증된 보완책이다 ([ox_inventory#1950](https://github.com/overextended/ox_inventory/pull/1950)).
- **핸들러 계약은 통일하는 편이 낫다** — 동기/비동기 두 종류를 병존시키면 호출자가 구분 책임을 떠안는다 ([Software Engineering SE](https://softwareengineering.stackexchange.com/questions/418036/combining-synchronous-and-asynchronous-commands-when-using-the-command-pattern)).
- **다만 async 전환 비용은 시그니처 전파**이며, 큰 단일 PR이 아니라 작은 수직 슬라이스로 쪼개야 한다 ([Start Debugging](https://startdebugging.net/2026/07/migrate-from-blocking-result-and-wait-calls-to-async-all-the-way-up-in-csharp/)).
- **eager vs lazy에 대한 게임 서버 맥락의 직접 비교 근거는 확보하지 못했다.** 이 결정은 리서치가 아니라 프로젝트 내부 제약(인벤 규모, 세션 진입 예산)으로 판단해야 한다.

## Sources

1. [MMO Architecture: Source of truth, Dataflows, I/O bottlenecks](https://prdeving.wordpress.com/2023/09/29/mmo-architecture-source-of-truth-dataflows-i-o-bottlenecks-and-how-to-solve-them/) — DB는 영속화 매체, 인메모리가 진실의 원천이라는 명제와 그 산술적 근거
2. [Digital Objects: How Virtual Worlds Work part 3 – Raph Koster](https://www.raphkoster.com/2021/10/07/digital-objects-how-virtual-worlds-work-part-3/) — 템플릿/인스턴스 이원 저장소 구조와 필드 분할 기준
3. [Flyweight · Game Programming Patterns](https://gameprogrammingpatterns.com/flyweight.html) — Flyweight와 Type Object의 의도 차이
4. [Prototype · Game Programming Patterns](https://gameprogrammingpatterns.com/prototype.html) — 원형 복제 계열 패턴 비교
5. [MUnique/OpenMU — Item.cs](https://github.com/MUnique/OpenMU/blob/master/src/DataModel/Entities/Item.cs) — MMORPG 서버의 실제 아이템 인스턴스 필드 구성
6. [ox_inventory PR #1950 — prevent item duplication on disconnect mid-swap](https://github.com/overextended/ox_inventory/pull/1950) — yield가 임계 구간에 들어가 발생한 아이템 복제 버그의 근본 원인과 수정
7. [Write-Behind (Write-Back) Caching Pattern — Redis Patterns](https://redis.antirez.com/fundamental/write-behind.html) — dirty 플래그 동기화 절차, write coalescing, 손실 창 완화책
8. [Combining synchronous and asynchronous commands when using the command pattern](https://softwareengineering.stackexchange.com/questions/418036/combining-synchronous-and-asynchronous-commands-when-using-the-command-pattern) — 명령 계약 통일 논거
9. [Migrate from blocking .Result/.Wait() calls to async all the way up](https://startdebugging.net/2026/07/migrate-from-blocking-result-and-wait-calls-to-async-all-the-way-up-in-csharp/) — async 전환의 파급 범위와 PR 분할 전략
10. [Read-Through, Write-Through, Refresh-Ahead and Write-Behind — Oracle Coherence](https://docs.oracle.com/cd/E13924_01/coh.340/e13819/readthrough.htm) — 캐시 영속화 모드 분류
11. [Persistence — Red Hat Data Grid User Guide](https://docs.redhat.com/en/documentation/red_hat_data_grid/7.3/html/red_hat_data_grid_user_guide/persistence) — write-behind 지연 큐 규정
12. [Separating Item Definition Data From Item Instance Data — Unity Discussions](https://discussions.unity.com/t/separating-item-definition-data-from-item-instance-data/752786) — 정의/인스턴스 분리 실무 논의
13. [secondlife/viewer #4972 — Async Inventory: Improve Login Performance](https://github.com/secondlife/viewer/issues/4972) — 로그인 시 인벤토리 로딩이 성능 병목이 된 사례(클라이언트 측)
14. [otland/forgottenserver #1150 — Lag from excessive items in containers](https://github.com/otland/forgottenserver/issues/1150) — 컨테이너 아이템 수 증가에 따른 서버 지연 보고
15. [MMORPG Data Storage (Part 1) — Plant Based Games](https://plantbasedgames.io/blog/posts/01-mmorpg-data-storage-part-one/) — MMORPG 데이터 저장 계층 개요
16. [Lazy vs eager loading performance on Entity Framework — Stack Overflow](https://stackoverflow.com/questions/15778375/lazy-vs-eager-loading-performance-on-entity-framework) — ORM 맥락의 lazy/eager 일반론

## Methodology

4개 하위 질문에 대해 2개 어댑터(adapter-exa `/search` type=auto, adapter-firecrawl `/v1/search`)를 각각 호출해 총 8개 검색 쿼리를 실행했다. 어댑터 실패 없음(8/8 HTTP 200). URL 정규화 기준 중복 제거 후 **고유 소스 60건**을 확보했고, 그중 결정 관련성이 높은 **8건을 adapter-exa `/contents`로 전문 심층 읽기**했다.

조사한 하위 질문:
1. 게임 서버 아이템 인스턴스 인메모리 라이브 상태 — eager hydrate vs lazy 조회 트레이드오프
2. 템플릿 정의/런타임 인스턴스 분리 데이터 모델링 (flyweight·prototype)
3. 동기 명령 핸들러 디스패처의 async 전환 마이그레이션 패턴과 파급
4. write-behind 영속화와 단일 소유권 불변식 — 아이템 복제 방지

**한계**: 하위 질문 4번(§4, eager vs lazy)에 대해 게임 서버 맥락의 정량적 비교 자료를 찾지 못했다. 해당 절의 결론은 간접 증거에 기반한 추론이며 본문에 그렇게 표시했다. §3.2의 async 전환 자료는 .NET 스레드 풀 모델을 전제하므로 Node.js 이벤트 루프 맥락으로 이식 가능한 범위를 본문에 명시했다.
