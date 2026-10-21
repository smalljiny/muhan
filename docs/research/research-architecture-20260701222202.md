# MUD 서버 아키텍처·프로토콜·테스트 전략: Research Report
*Generated: 2026-07-01 | Sources: 22 | Adapters: [adapter-exa, adapter-firecrawl] | Failed: none*

## Executive Summary

무한 MUD 포팅의 아키텍처 결정(이슈 #14)을 외부 선례로 검증하려고 진행한 리서치다. 세 축은 런타임과 영속화, 프로토콜과 채널, 포팅 테스트 전략이다. 세 축 모두에서 확정 결정과 잘 맞는 업계 선례를 확인했다.

1. 무한의 조상인 DikuMUD 계열 서버는 단일 스레드 이벤트 루프를 쓴다. 초당 ~10pulse로 도는 heartbeat를 modulo 연산으로 서브시스템마다 나눠 준다. 현대 엔진(Evennia)은 전역 틱 대신, 필요한 객체만 구독하는 모델을 쓴다.
2. Node 프로세스 하나가 WebSocket 동시 연결을 3만~10만 개까지 처리한다. 따라서 소규모 MUD는 단일 프로세스와 in-process EventEmitter로 충분하고, Redis는 나중에 도입하는 것이 맞다.
3. 게임 프로토콜에서는 command 계약과 event 계약을 나누는 것이 자리 잡은 패턴이다. 메시지마다 Zod 스키마를 하나씩 두고 `z.infer`로 타입을 얻으며, 이를 monorepo 공유 패키지에 둔다.
4. 레거시 공식을 포팅할 때의 테스트는 golden master, characterization, approval test로 불린다. 셋은 같은 기법이다. 원본을 behavioral oracle로 삼아 fixture를 동결하고, 버그도 bug-for-bug로 재현하며, fixture는 함수별로 좁게 유지한다.

## 1. 런타임 루프·틱 모델 (D1 검증)

- 무한의 조상인 DikuMUD/CircleMUD 계열(LuminariMUD)은 **단일 스레드 이벤트 루프가 초당 ~10 pulse(0.1초)** 로 돈다. 매 pulse마다 network select, 입력 처리, 명령 실행, 출력 flush, heartbeat를 차례로 수행한다 ([LuminariMUD CORE_SERVER_ARCHITECTURE](https://github.com/LuminariMUD/Luminari-Source/blob/master/docs/systems/CORE_SERVER_ARCHITECTURE.md)). 이는 무한 A1 노트의 `sock_loop`+`update_game` 구조와 같다.
- Heartbeat에서는 **타이머 하나가 `pulse % N` modulo 연산으로 서브시스템마다 다른 간격을 나눠 준다**. 이벤트는 매 pulse, 스크립트는 0.5초, 이동과 타이머는 1초, NPC 활동은 5초, 존 리셋은 30초, 게임 시간은 75초 간격이다 ([LuminariMUD](https://github.com/LuminariMUD/Luminari-Source/blob/master/docs/systems/CORE_SERVER_ARCHITECTURE.md)). 무한의 `update_*` 간격 검사와 정확히 같은 패턴이다. 그래서 중앙 1Hz heartbeat를 두고 서브시스템을 modulo로 나누는 결정을 뒷받침한다.
- LPMud 계열(LDMUD)은 heartbeat를 **시간 예산 안에서, 중단 후 재개할 수 있게, 협력적으로** 처리한다. living object가 없으면 heartbeat를 아예 실행하지 않는다 ([ldmud/heartbeat.c](https://github.com/ldmud/ldmud/blob/master/src/heartbeat.c)). 무한 A9의 "빈 방=시간 정지"와, 활성 크리처만 next-action 큐에 두도록 다듬은 방향과 일치한다.
- 현대 엔진 Evennia에는 **반드시 도는 전역 틱이 없다**. 대신 구독 모델(`TICKER_HANDLER`)을 제공한다. 객체가 공유 인터벌을 subscribe하면, 타이머 하나가 모든 구독자를 처리하며, 이 구독은 reboot 후에도 유지된다 ([Evennia TickerHandler](https://www.evennia.com/docs/latest/Components/TickerHandler.html)). D1의 "엔티티별 next-action 큐(setTimeout 남발 금지)" 결정의 현대적 선례다.
- Node.js 실시간 서버는 `select()` 대신 이벤트 루프와 **고정 인터벌마다 비우는 메시지 큐**를 쓴다. 예를 들어 50ms마다 큐의 메시지를 순서대로 처리하고, 상태를 진행하고, 델타를 방송한 뒤 큐를 비운다 ([SO: Node.js/Mongo/Socket.IO game loop](https://stackoverflow.com/questions/32137681/real-time-multiplayer-game-using-node-js-mongodb-and-socket-io-game-loop-and)). 순수 JS MUD 엔진인 RanvierMUD를 참조 구현으로 볼 수 있다 ([RanvierMUD](https://github.com/RanvierMUD/ranviermud)). 게임 루프 자체는 기본 패턴이다 ([Game Programming Patterns](https://gameprogrammingpatterns.com/game-loop.html)).

## 2. 인메모리 권위 상태 ↔ DB 영속화 경계 (D2 검증)

- **시뮬레이션은 메모리에서 하고, DB에는 정해진 시점에 의도한 스냅샷만 쓴다.** 상태가 바뀔 때마다 블로킹 I/O를 바로 하면 안 된다. 그래서 Network, Session, 권위 월드 틱, 도메인 변경, 영속화 경계, 저장 어댑터 순으로 계층 경계를 둔다 ([AlgoDaily: Game Server Persistence](https://algodaily.com/lessons/lesson-5-game-server-persistence-083ca31a)). D2의 "메모리 그래프 권위, DB 왕복 금지"와 일치한다.
- **"객체 그래프가 아니라 값을 저장하라"** 는 원칙도 있다. 포인터 대신 안정된 ID를, 엔진 객체 대신 평문 값을 저장하고, 마이그레이션용 version 필드를 둔다 ([AlgoDaily](https://algodaily.com/lessons/lesson-5-game-server-persistence-083ca31a)). 무한이 1993 raw-struct 덤프를 버리고 MongoDB 네이티브 문서로 가는 결정([[muhan-mud-port]])을 직접 검증한다.
- **세이브는 틱과 분리해 snapshot → queue → async worker 순서로 처리한다.** 틱이 안전한 시점에 불변 스냅샷을 만들어 영속화 큐에 넣으면, 저장 워커가 로깅과 재시도를 하며 기록한다 ([AlgoDaily](https://algodaily.com/lessons/lesson-5-game-server-persistence-083ca31a)).
- **autosave의 정석은 dirty-flag를 써서 선택적으로, 개별로, 비동기로 저장하는 것이다.** 바뀐 것(dirty=true)만, 엔티티마다 따로(시간을 분산해), 비동기로 저장한다 ([gamedev.stackexchange](https://gamedev.stackexchange.com/questions/31944/best-practices-for-periodically-saving-game-state-to-disk)). D2의 "DB 네이티브 신규 세이브 정책(dirty 주기 flush + 이벤트 즉시 write)"과 정확히 일치한다. fork/COW 스냅샷은 C/Unix 기법이라 단일 프로세스 Node 포팅에는 맞지 않아 대안으로만 적어 둔다.
- **플레이어 프로필 저장에는 MongoDB가 사실상 표준이다.** 스키마가 유연하고, 캐릭터 스폰이 단일 문서 읽기 1쿼리로 끝난다(SQL은 4+ 조인). 이 출처는 "DB가 절대 진실 원천"이라고 하며, 크래시 때 ~30초 롤백은 감수하되 DB가 손상되어서는 안 된다고 한다 ([Player Data Schema 2026](https://crux.supercraft.host/blog/player-data-schema-design-nosql-vs-sql/)). 다만 벤더 블로그라 홍보 성격을 감안해야 한다. 인벤토리, 통화, 업적은 플레이어 문서에 임베드한다 ([Reintech: MongoDB for Gaming](https://reintech.io/blog/mongodb-for-gaming-storing-querying-player-data)). player-scoped 문서와 project-scoped 공유 문서를 나누고, write는 서버 권위로 한다 ([Crux: Persistent Data](https://crux.supercraft.host/blog/persistent-data-and-shared-state/)). D8 monorepo와 D2 스키마 설계에서 참조한다.

## 3. WebSocket 구조화 프로토콜·공유 타입 (D4 검증)

- **들어오는 command 계약과 나가는 event 계약을 명시적으로 나눈다.** `zod-sockets`는 incoming을 "Action"(input+ack 스키마)으로, outgoing을 "Emission"으로 정의한다. 설정을 프론트로 export해 계약을 강제하고 AsyncAPI 문서를 생성한다 ([RobinTail/zod-sockets](https://github.com/RobinTail/zod-sockets)). 한 4X 게임은 공유 패키지에 `GameCommand`와 `GameEvent`를 따로 둔다 ([Ernest.dev](https://ernest.dev/2026/05/31/aonw-how-i-built-multiplayer-for-a-turn-based-4x-game-with-flutter-dart-websockets-and-postgresql/)). D4의 5개 인자 패턴, 구조화 이벤트와 일치한다.
- **메시지마다 Zod 스키마를 1개 두고 `z.infer`로 TS 타입을 얻는다. 같은 내용의 `type`을 따로 손으로 관리하지 않는다.** 스키마는 client와 server가 함께 쓰는 곳(내부 npm 패키지나 monorepo 폴더)에 둔다 ([DEV/Nevavuori](https://dev.to/jussinevavuori/end-to-end-typesafe-apis-with-typescript-and-shared-zod-schemas-4jmo)). 프로덕션 RTS인 OpenFrontIO는 모든 클라이언트 액션을 `Intent` discriminated union으로 모델링하며, 각 멤버는 `z.infer`로 만든다 ([OpenFrontIO Schemas.ts](https://github.com/openfrontio/OpenFrontIO/blob/20bc311c/src/core/Schemas.ts)). D4의 "Zod 단일 출처 + monorepo shared" 결정을 직접 검증한다.
- **네임스페이스가 붙은 `action`/`type` discriminator 래퍼**(`domain:action`, `table:join` 등)로 서버가 메시지를 라우팅하고, 받을 때 Zod discriminated union으로 파싱한다 ([Shoehive command-system](https://github.com/jtay/shoehive/blob/main/docs/pages/api/6_command-system.md)).
- 타입 공유 방법의 우선순위는 (1) monorepo 공유 패키지, (2) OpenAPI/GraphQL, (3) tRPC 순이다. 라우터를 `/packages/api`에 dev dependency로 두면 타입은 빌드 때 지워진다. 그래서 서버 코드를 배포하지 않고도 타입 안전을 얻는다 ([tRPC Discussion #6980](https://github.com/trpc/trpc/discussions/6980); [r/typescript](https://www.reddit.com/r/typescript/comments/1cjvvln/best_practices_for_sharing_types_between_backend/)). D8의 pnpm monorepo shared 패키지 결정을 뒷받침한다.
- (맥락에 따라 다르며 출처가 하나뿐이다.) 턴제 게임은 상태를 바꾸는 command를 HTTP로 보내고, WS는 서버 푸시 알림에만 쓰며, `event_offset` 리플레이 로그를 두기도 한다 ([Ernest.dev](https://ernest.dev/2026/05/31/aonw-how-i-built-multiplayer-for-a-turn-based-4x-game-with-flutter-dart-websockets-and-postgresql/)). 실시간 MUD는 명령을 소켓으로 계속 보내도 된다.

## 4. 브로드캐스트 채널·Redis 확장 (D3 검증)

- **EventEmitter는 단일 프로세스 안에서 한 번만 처리하는 용도이고, Redis는 노드 간 fan-out 용도다.** 클러스터 전체에서 한 번만 처리해야 하는 작업에는 pub/sub이 아니라 Redis list 큐(RPUSH/LPOP)를 쓴다 ([SO: Redis pub/sub vs EventEmitter](https://stackoverflow.com/questions/65772945/redis-pub-sub-vs-node-js-eventemitter-for-only-once-processed-events)). D3의 "in-process EventEmitter 채널" 결정과 일치한다.
- **프로세스 하나가 WS 동시 연결을 3만~10만 개 처리한다**(연결당 ~5~50KiB). 이를 넘을 때만 수평 확장한다 ([Stack Harbor](https://stackharbor.com/en/knowledge-base/nodejs-websocket-scaling-pattern/)). 이것이 핵심 트레이드오프 수치다. 무한의 목표(수십~수백 CCU)는 **단일 프로세스로 충분하고도 크게 남는다**. 따라서 D1 단일 프로세스와 D3 Redis 후순위 결정을 수치로 확인해 준다.
- 수평 확장을 하면 새 문제 3개가 생긴다. (1) stickiness: LB가 세션을 가진 노드로 요청을 보내야 한다. (2) 노드 간 방송: Redis pub/sub 어댑터가 메시지를 중계한다. (3) presence: TTL을 갱신하는 Redis hash로 관리한다 ([Stack Harbor](https://stackharbor.com/en/knowledge-base/nodejs-websocket-scaling-pattern/)).
- **fan-out이 증폭되는 함정이 있다. 방마다 채널을 구독하고 wildcard는 쓰지 않는다.** `psubscribe('room:*')`를 쓰면 모든 노드가 모든 방의 메시지를 받는다. 그러면 전달량이 노드 수에 대해 **2차(P×N×N)** 로 늘어난다. 해결책은 방에 첫 로컬 멤버가 들어올 때만 구독하고, 마지막 멤버가 나갈 때 해제하는 것이다 ([AhsanLab, 2026, 1~8노드 벤치마크](https://tech.ahsanlab.me/posts/scaling-websockets-horizontally-with-redis-pubsub-with-benchmarks)). 나중에 Redis를 도입할 때 D3의 방=채널 설계가 지켜야 할 규칙이다.
- Socket.IO는 공식 어댑터 5개(Redis/Redis Streams/Mongo/Postgres/Cluster)를 제공하며, `io.to('room:42').emit()`이 모든 노드에 전달된다 ([Socket.IO step-9](https://socket.io/docs/v4/tutorial/step-9)). 참조할 스택으로는 Node/TS와 Redis pub/sub+큐를 쓰는 룸 기반 멀티플레이어가 있다 ([TanishValesha/Scalable-Realtime-Multiplayer-System](https://github.com/TanishValesha/Scalable-Realtime-Multiplayer-System)).

## 5. 레거시 공식 포팅 테스트 전략 (D7 검증)

- **golden master, characterization, approval test는 같은 기법의 다른 이름이다.** 명세가 아니라 *실제* 동작을 기록해 두고, 동작이 바뀌면 테스트가 실패한다. 단계는 3개다. (1) 코드를 자동 테스트에 넣는다(의존성을 끊는 것이 어렵다). (2) 출력을 기록한다. (3) 입력을 바꿔 가며 시나리오를 넓힌다. 일부러 버그를 넣어 최소 1개 테스트가 실제로 실패하는지 확인한다 ([understandlegacycode](https://understandlegacycode.com/blog/characterization-tests-or-approval-tests/); [Wikipedia](https://en.wikipedia.org/wiki/Characterization_test)).
- 이 용어를 만든 Michael Feathers("테스트 없는 코드=레거시")는 이를 **"해야 할 것"이 아니라 "실제 하는 것"을 기록하는** 가설 주도 방식으로 정의한다. 관측한 출력을 expected 값으로 붙여 넣는 식이다 ([Michael Feathers](https://michaelfeathers.silvrback.com/characterization-testing)). `legacy/muhan/src`를 behavioral oracle로 쓰는 D7 접근과 정확히 일치한다.
- **approval 도구는 snapshot/freeze fixture를 자동으로 만들고, "combination approvals"로 공식의 입력 공간을 넓게 다룬다.** 그래서 파라미터가 여럿인 수치 공식(전투, thaco, 마법 테이블)에 알맞다 ([8th Light](https://8thlight.com/insights/add-approval-testing-to-your-toolbox); [ApprovalTests.com](https://approvaltests.com/); [Codurance](https://www.codurance.com/publications/2012/11/11/testing-legacy-code-with-golden-master)).
- **differential/oracle 대조는 기존 구현을 oracle로 삼아 나란히 실행하고 불일치를 저장하는 방식이다.** 진짜 위험은 *semantic drift*다. 컴파일과 유닛 테스트를 통과하고 성능도 좋아졌는데 로직이 조용히 어긋나는 경우를 말한다. 이 출처는 "동등성 증명이 제품이고 코드는 산출물일 뿐; AI가 oracle을 *운영*하되 oracle *이 되게* 하지 말라"고 한다 ([Adnan Masood/Medium](https://medium.com/@adnanmasood/architectural-testing-patterns-for-agentic-sdlc-in-legacy-modernization-5e8ffa1e0299)). 실무 블로그이고 일부는 유료 공개다. 문헌에서는 독립된 구현끼리 비교해 편차를 찾는 것으로 정의한다 ([Emergent Mind](https://www.emergentmind.com/topics/differential-testing); [Gulzar et al. PDF](https://people.cs.vt.edu/~gulzar/assets/pdf/p71-gulzar.pdf)). 무한의 기존 JS 파서를 C oracle과 바이트 단위로 diff해 검증한 방식과 같은 구조다.
- **property-based 테스트는 수치 공식의 범위를 검사하는 데 알맞으며, 결정성이 전제다.** 한 게임 엔진 사례는 fast-check로 CI마다 2,000~10,000개 시드의 전투를 돌려 전투 불변식을 증명한다. ambient `Math.random()`이나 부동소수 drift가 있으면 shrinker, 리플레이, 밸런스 근거가 한꺼번에 무너진다("nondeterminism becomes poison") ([Forges of Karinth](https://danjohnson.dev/work/forges-of-karinth), 단일 출처). 우리는 RNG 시드를 고정하고 불변식(데미지≥0, 명중률 범위)을 assert하는 데 적용한다.
- **bug-for-bug 호환에는 forensic 재구성과 재구현이라는 두 층이 있다.** Fallout2-re는 컴파일러 출력까지 맞추는 forensic 재구성이다(reccmp로 함수를 diff한다). OpenTTD와 OpenMW는 재구현이다 ([brightcoding](https://converter.brightcoding.dev/blog/i-reverse-engineered-fallout-2-heres-the-insane-technical-story); [isledecomp/reccmp](https://github.com/isledecomp/reccmp?tab=readme-ov-file)). 무한 포팅은 1:1 트랜스파일이 아니다. 방침은 **관측된 동작(공식, 반올림, off-by-one)은 bug-for-bug로 재현하되 소프트웨어 구현 방식은 자유롭게 재설계하는 것**이다. 즉 binary parity가 아니라 behavioral parity다. §1.7 as-shipped 정책과 정확히 일치한다.
- fixture를 유지보수할 때 주의할 점이 있다. 큰 공유 fixture는 code smell이 될 수 있으니 **함수별, 입력 범위별로 좁게** 유지한다 ([HN 2024+](https://news.ycombinator.com/item?id=46203948), 포럼이라 신뢰도가 낮다). D7의 "frozen 골든 fixture"를 함수 단위로 설계할 근거다.

## Key Takeaways

- **D1·D3를 수치로 확인했다**: Node 프로세스 하나가 WS 연결 3만~10만 개를 처리한다. 따라서 무한의 목표(수십~수백)는 단일 프로세스와 in-process EventEmitter로 충분하고도 크게 남으며, Redis를 나중으로 미루는 것이 맞다. Colyseus를 쓰지 않기로 한 결정과도 맞는다. 애초에 스케일링 문제가 없기 때문이다.
- **D1 heartbeat 패턴은 DikuMUD 계열의 표준이다**(타이머 하나와 modulo 서브시스템 분배). 그래서 무한 A1 구조를 그대로 현대 스케줄러로 옮기면 된다. Evennia 구독 모델과 LPMud 시간 예산 heartbeat는 "활성 크리처 next-action 큐"로 다듬은 방향의 선례다.
- **D2 세이브 정책의 신규 설계는 업계 정석과 일치한다**: 인메모리 상태를 권위로 두고, snapshot→queue→async worker로 저장하며, dirty-flag로 골라 개별로 비동기 flush한다. "객체 그래프 말고 값 저장" 원칙이 raw-struct→MongoDB 문서 결정을 검증한다.
- **D4·D8 프로토콜에는 자리 잡은 패턴이 있다**: command/event 계약 분리, 메시지당 Zod 스키마와 `z.infer`, monorepo 공유 패키지, `domain:action` discriminator다. 직접 구현하는 것이 검증된 방법이며 프레임워크는 필요 없다.
- **D7은 characterization, golden master, oracle 대조를 교과서대로 적용한 것이다**: 원본을 behavioral oracle로 쓰고, frozen fixture는 함수별로 두며, 버그는 §1.7대로 bug-for-bug로 재현한다(behavioral parity). property-based 테스트는 RNG 시드 고정을 전제로 공식의 범위를 다룬다. combination approvals는 파라미터가 여럿인 전투/마법 테이블에 알맞다.

## Sources

1. [LuminariMUD CORE_SERVER_ARCHITECTURE](https://github.com/LuminariMUD/Luminari-Source/blob/master/docs/systems/CORE_SERVER_ARCHITECTURE.md) — DikuMUD 계열의 단일 스레드 10pulse/sec 루프와 modulo heartbeat.
2. [ldmud/heartbeat.c](https://github.com/ldmud/ldmud/blob/master/src/heartbeat.c) — LPMud의 시간 예산 기반, 재개 가능한 협력적 heartbeat.
3. [Evennia TickerHandler](https://www.evennia.com/docs/latest/Components/TickerHandler.html) — 전역 틱을 선택적으로 쓰는 구독 모델.
4. [RanvierMUD](https://github.com/RanvierMUD/ranviermud) — 순수 Node.js MUD 엔진.
5. [SO: Node.js/Mongo/Socket.IO game loop](https://stackoverflow.com/questions/32137681/real-time-multiplayer-game-using-node-js-mongodb-and-socket-io-game-loop-and) — 큐를 비우는 루프.
6. [SO: MUD timed events](https://stackoverflow.com/questions/2748084/mud-game-design-concept-question-about-timed-events) — 객체별 ~2초 heartbeat.
7. [Game Programming Patterns: Game Loop](https://gameprogrammingpatterns.com/game-loop.html) — 게임 루프 기본 패턴.
8. [AlgoDaily: Game Server Persistence](https://algodaily.com/lessons/lesson-5-game-server-persistence-083ca31a) — 인메모리 시뮬레이션과 스냅샷 경계, 값 저장, snapshot→queue→worker.
9. [gamedev.stackexchange: periodic save](https://gamedev.stackexchange.com/questions/31944/best-practices-for-periodically-saving-game-state-to-disk) — dirty-flag로 골라 개별로 비동기 저장하는 autosave.
10. [Player Data Schema MongoDB vs Postgres 2026](https://crux.supercraft.host/blog/player-data-schema-design-nosql-vs-sql/) — DB를 진실 원천으로 두는 NoSQL 프로필 (벤더 블로그).
11. [Crux: Persistent Data and Shared State](https://crux.supercraft.host/blog/persistent-data-and-shared-state/) — player-scoped와 project-scoped 분리, 서버 권위 write.
12. [Reintech: MongoDB for Gaming](https://reintech.io/blog/mongodb-for-gaming-storing-querying-player-data) — 인벤토리/통화/업적 임베드.
13. [Ernest.dev: 4X multiplayer](https://ernest.dev/2026/05/31/aonw-how-i-built-multiplayer-for-a-turn-based-4x-game-with-flutter-dart-websockets-and-postgresql/) — 공유 코어의 GameCommand/GameEvent, HTTP+WS+event_offset.
14. [RobinTail/zod-sockets](https://github.com/RobinTail/zod-sockets) — Action(incoming)/Emission(outgoing) Zod 검증, 계약 export.
15. [DEV/Nevavuori: shared Zod schemas](https://dev.to/jussinevavuori/end-to-end-typesafe-apis-with-typescript-and-shared-zod-schemas-4jmo) — z.infer와 monorepo 공유.
16. [OpenFrontIO Schemas.ts](https://github.com/openfrontio/OpenFrontIO/blob/20bc311c/src/core/Schemas.ts) — Intent discriminated union.
17. [Shoehive command-system](https://github.com/jtay/shoehive/blob/main/docs/pages/api/6_command-system.md) — `domain:action` 래퍼와 MessageRouter.
18. [tRPC Discussion #6980](https://github.com/trpc/trpc/discussions/6980) — router를 /packages/api에 두고 빌드 때 타입 소거 (r/typescript 함께 참조).
19. [SO: Redis pub/sub vs EventEmitter](https://stackoverflow.com/questions/65772945/redis-pub-sub-vs-node-js-eventemitter-for-only-once-processed-events) — in-process once-only 처리와 노드 간 처리 비교.
20. [Stack Harbor: WS scaling](https://stackharbor.com/en/knowledge-base/nodejs-websocket-scaling-pattern/) — 프로세스당 3만~10만 conn, stickiness/broadcast/presence, Socket.IO Redis adapter.
21. [AhsanLab: Redis pub/sub scaling benchmarks](https://tech.ahsanlab.me/posts/scaling-websockets-horizontally-with-redis-pubsub-with-benchmarks) — wildcard fan-out 증폭, 방별로 필요할 때만 구독.
22. [Socket.IO step-9](https://socket.io/docs/v4/tutorial/step-9) — 공식 어댑터 5개. + 테스트 출처: [understandlegacycode](https://understandlegacycode.com/blog/characterization-tests-or-approval-tests/), [Michael Feathers](https://michaelfeathers.silvrback.com/characterization-testing), [8th Light](https://8thlight.com/insights/add-approval-testing-to-your-toolbox), [ApprovalTests](https://approvaltests.com/), [Codurance](https://www.codurance.com/publications/2012/11/11/testing-legacy-code-with-golden-master), [Adnan Masood](https://medium.com/@adnanmasood/architectural-testing-patterns-for-agentic-sdlc-in-legacy-modernization-5e8ffa1e0299), [Emergent Mind](https://www.emergentmind.com/topics/differential-testing), [Gulzar et al.](https://people.cs.vt.edu/~gulzar/assets/pdf/p71-gulzar.pdf), [Wikipedia Characterization](https://en.wikipedia.org/wiki/Characterization_test), [Forges of Karinth](https://danjohnson.dev/work/forges-of-karinth), [brightcoding Fallout2 RE](https://converter.brightcoding.dev/blog/i-reverse-engineered-fallout-2-heres-the-insane-technical-story), [isledecomp/reccmp](https://github.com/isledecomp/reccmp?tab=readme-ov-file), [HN frozen fixtures](https://news.ycombinator.com/item?id=46203948).

## Methodology

서브질문 5개(런타임 루프/틱, 인메모리↔DB 영속화, WS 프로토콜, pub/sub 채널, 레거시 포팅 테스트)를 리서치 에이전트 3개가 병렬로 조사했다. adapter-exa와 adapter-firecrawl을 모두 썼고 실패는 없었다. 출처 22개를 분석했고, 그중 핵심 9개는 깊이 읽었다. 모든 축에서 이슈 #14의 확정 결정과 일치하는 선례를 확인했다. 신뢰도가 낮은 출처(벤더 블로그, 포럼, 단일 출처)는 본문에 따로 표시했다.
