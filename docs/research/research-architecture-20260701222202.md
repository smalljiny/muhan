# MUD 서버 아키텍처·프로토콜·테스트 전략: Research Report
*Generated: 2026-07-01 | Sources: 22 | Adapters: [adapter-exa, adapter-firecrawl] | Failed: none*

## Executive Summary

무한 MUD 포팅의 아키텍처 결정(이슈 #14)을 외부 선례로 검증하기 위한 리서치다. 세 축(런타임·영속화 / 프로토콜·채널 / 포팅 테스트 전략)에서 확정 결정과 강하게 일치하는 업계 선례를 확인했다. (1) DikuMUD 계열(무한의 조상) 서버는 단일 스레드 이벤트 루프 + ~10pulse/sec heartbeat를 modulo로 서브시스템에 분배하며, 현대 엔진(Evennia)은 전역 틱을 선택적 구독 모델로 대체한다. (2) 단일 Node 프로세스가 WebSocket 3만~10만 동시 연결을 처리하므로 소규모 MUD엔 단일 프로세스 + in-process EventEmitter가 충분하고 Redis는 후순위가 맞다. (3) 게임 프로토콜은 command/event 계약을 분리하고 메시지당 Zod 스키마 + `z.infer`를 monorepo 공유 패키지로 두는 것이 정착된 패턴이다. (4) 레거시 공식 포팅 테스트는 golden master=characterization=approval(동일 기법)로 원본을 behavioral oracle로 삼아 fixture를 동결하고, 버그를 bug-for-bug로 재현하되 fixture는 함수별로 좁게 유지한다.

## 1. 런타임 루프·틱 모델 (D1 검증)

- 무한의 조상인 DikuMUD/CircleMUD 계열(LuminariMUD)은 **단일 스레드 이벤트 루프가 초당 ~10 pulse(0.1초)** 로 회전하며 매 pulse에서 network select → 입력 처리 → 명령 실행 → 출력 flush → heartbeat를 수행한다 ([LuminariMUD CORE_SERVER_ARCHITECTURE](https://github.com/LuminariMUD/Luminari-Source/blob/master/docs/systems/CORE_SERVER_ARCHITECTURE.md)). 이는 무한 A1 노트의 `sock_loop`+`update_game` 구조와 동형이다.
- Heartbeat는 **단일 타이머가 `pulse % N` modulo로 서브시스템을 상이 간격에 분배**한다(이벤트 매 pulse, 스크립트 0.5초, 이동/타이머 1초, NPC 활동 5초, 존 리셋 30초, 게임시간 75초) ([LuminariMUD](https://github.com/LuminariMUD/Luminari-Source/blob/master/docs/systems/CORE_SERVER_ARCHITECTURE.md)). 무한의 `update_*` 간격 게이트와 정확히 같은 패턴 → 중앙 1Hz heartbeat + 서브시스템 modulo 분배 결정을 뒷받침.
- LPMud 계열(LDMUD)은 heartbeat를 **시간 예산 기반·재개 가능·협력적**으로 처리하며, living object가 없으면 아예 실행하지 않는다 ([ldmud/heartbeat.c](https://github.com/ldmud/ldmud/blob/master/src/heartbeat.c)). 무한 A9의 "빈 방=시간 정지" + 활성 크리처 next-action 큐 refine과 일치.
- 현대 엔진 Evennia는 **전역 필수 틱이 없고** 구독 모델(`TICKER_HANDLER`)을 제공 — 객체가 공유 인터벌에 subscribe, 하나의 타이머가 모든 구독자 서비스, reboot 생존 ([Evennia TickerHandler](https://www.evennia.com/docs/latest/Components/TickerHandler.html)). D1의 "엔티티별 next-action 큐(setTimeout 남발 금지)" 결정에 대한 현대적 선례.
- Node.js 실시간 서버는 `select()`를 이벤트 루프 + **고정 인터벌로 드레인하는 메시지 큐**로 대체한다(예: 50ms마다 큐의 메시지 순차 처리 → 상태 진행 → 델타 방송 → 큐 clear) ([SO: Node.js/Mongo/Socket.IO game loop](https://stackoverflow.com/questions/32137681/real-time-multiplayer-game-using-node-js-mongodb-and-socket-io-game-loop-and)). 순수 JS MUD 엔진 RanvierMUD가 참조 구현 ([RanvierMUD](https://github.com/RanvierMUD/ranviermud)). 게임 루프는 근본 패턴 ([Game Programming Patterns](https://gameprogrammingpatterns.com/game-loop.html)).

## 2. 인메모리 권위 상태 ↔ DB 영속화 경계 (D2 검증)

- **시뮬레이션은 메모리에서, DB는 통제된 지점의 의도적 스냅샷만.** 모든 상태 변경이 즉시 블로킹 I/O를 하면 안 되며, 계층 경계(Network → Session → 권위 월드 틱 → 도메인 변경 → 영속화 경계 → 저장 어댑터)를 둔다 ([AlgoDaily: Game Server Persistence](https://algodaily.com/lessons/lesson-5-game-server-persistence-083ca31a)). D2의 "메모리 그래프 권위, DB 왕복 금지"와 정합.
- **"객체 그래프가 아니라 값을 저장하라"** — 포인터 대신 안정 ID, 엔진 객체 대신 평문 값, 마이그레이션용 version 필드 ([AlgoDaily](https://algodaily.com/lessons/lesson-5-game-server-persistence-083ca31a)). 무한이 1993 raw-struct 덤프를 버리고 MongoDB 네이티브 문서로 가는 결정([[muhan-mud-port]])을 직접 검증.
- **세이브는 틱과 분리: snapshot → queue → async worker.** 틱이 안전 시점에 불변 스냅샷 생성 → 영속화 큐 push → 저장 워커가 로깅·재시도와 함께 기록 ([AlgoDaily](https://algodaily.com/lessons/lesson-5-game-server-persistence-083ca31a)).
- **autosave 정석 = dirty-flag + 선택적 + 개별 + 비동기.** 변경된 것만(dirty=true), 엔티티 개별로(시간 분산), 비동기로 저장 ([gamedev.stackexchange](https://gamedev.stackexchange.com/questions/31944/best-practices-for-periodically-saving-game-state-to-disk)). D2의 "DB 네이티브 신규 세이브 정책(dirty 주기 flush + 이벤트 즉시 write)"과 정확히 일치. (fork/COW 스냅샷은 C/Unix 기법이라 단일 프로세스 Node 포팅엔 부적용 — 대안으로만 표기.)
- **MongoDB가 플레이어 프로필의 사실상 표준**(스키마 유연성, 단일 문서 읽기로 캐릭터 스폰 1쿼리 vs SQL 4+ 조인). "DB가 절대 진실 원천"이며 크래시 시 ~30초 롤백은 감수하되 DB는 손상 금지 ([Player Data Schema 2026](https://crux.supercraft.host/blog/player-data-schema-design-nosql-vs-sql/), 벤더 블로그 — advocacy 감안). 인벤토리·통화·업적을 플레이어 문서에 임베드 ([Reintech: MongoDB for Gaming](https://reintech.io/blog/mongodb-for-gaming-storing-querying-player-data)); player-scoped 문서 vs project-scoped 공유 문서 분리, 서버 권위 write ([Crux: Persistent Data](https://crux.supercraft.host/blog/persistent-data-and-shared-state/)). D8 monorepo·D2 스키마 설계 참조.

## 3. WebSocket 구조화 프로토콜·공유 타입 (D4 검증)

- **incoming command 계약과 outgoing event 계약을 명시적으로 분리.** `zod-sockets`는 incoming을 "Action"(input+ack 스키마), outgoing을 "Emission"으로 형식화하고 설정을 프론트로 export해 계약을 강제하며 AsyncAPI 생성 ([RobinTail/zod-sockets](https://github.com/RobinTail/zod-sockets)). 4X 게임은 공유 패키지에 `GameCommand`/`GameEvent` 분리 ([Ernest.dev](https://ernest.dev/2026/05/31/aonw-how-i-built-multiplayer-for-a-turn-based-4x-game-with-flutter-dart-websockets-and-postgresql/)). D4의 5개 인자 패턴·구조화 이벤트와 정합.
- **메시지당 Zod 스키마 1개 + `z.infer`로 TS 타입 파생, 병렬 `type` 수동 관리 금지.** 스키마를 client/server 공용 위치(내부 npm 패키지·monorepo 폴더)에 둔다 ([DEV/Nevavuori](https://dev.to/jussinevavuori/end-to-end-typesafe-apis-with-typescript-and-shared-zod-schemas-4jmo)). 프로덕션 RTS OpenFrontIO는 모든 클라 액션을 `Intent` discriminated union(`z.infer` 멤버)으로 모델링 ([OpenFrontIO Schemas.ts](https://github.com/openfrontio/OpenFrontIO/blob/20bc311c/src/core/Schemas.ts)). D4의 "Zod 단일 출처 + monorepo shared" 결정을 직접 검증.
- **네임스페이스 `action`/`type` discriminator 래퍼**(`domain:action`, `table:join` 등)로 서버가 라우팅, 수신 시 Zod discriminated-union 파싱 ([Shoehive command-system](https://github.com/jtay/shoehive/blob/main/docs/pages/api/6_command-system.md)).
- 타입 공유 옵션 순위: (1) monorepo 공유 패키지, (2) OpenAPI/GraphQL, (3) tRPC. 라우터를 `/packages/api`에 dev dependency로 두면 타입은 빌드 시 소거돼 서버 코드 미배포로 타입 안전 확보 ([tRPC Discussion #6980](https://github.com/trpc/trpc/discussions/6980); [r/typescript](https://www.reddit.com/r/typescript/comments/1cjvvln/best_practices_for_sharing_types_between_backend/)). D8 pnpm monorepo shared 패키지 결정 뒷받침.
- (컨텍스트 의존, 단일 출처) 턴제 게임은 mutating command를 HTTP로, WS는 서버 푸시 알림 전용으로 두고 `event_offset` 리플레이 로그를 두기도 한다 ([Ernest.dev](https://ernest.dev/2026/05/31/aonw-how-i-built-multiplayer-for-a-turn-based-4x-game-with-flutter-dart-websockets-and-postgresql/)) — 실시간 MUD는 명령을 소켓에 유지 가능.

## 4. 브로드캐스트 채널·Redis 확장 (D3 검증)

- **EventEmitter=단일 프로세스 내/한 번만 처리, Redis=크로스노드 fan-out.** 클러스터 전역 once-only 작업엔 pub/sub이 아닌 Redis list 큐(RPUSH/LPOP) 사용 ([SO: Redis pub/sub vs EventEmitter](https://stackoverflow.com/questions/65772945/redis-pub-sub-vs-node-js-eventemitter-for-only-once-processed-events)). D3의 "in-process EventEmitter 채널" 결정 정합.
- **단일 프로세스가 WS 3만~10만 동시 연결을 처리**(연결당 ~5~50KiB), 초과 시에만 수평 확장 ([Stack Harbor](https://stackharbor.com/en/knowledge-base/nodejs-websocket-scaling-pattern/)). 핵심 트레이드오프 수치: 무한 목표(수십~수백 CCU)는 **단일 프로세스로 압도적 여유** → D1 단일 프로세스·D3 Redis 후순위 결정을 정량적으로 확증.
- 수평 확장 시 새 문제 3개: (1) stickiness(LB가 세션 보유 노드로 라우팅), (2) 크로스노드 방송(Redis pub/sub 어댑터 릴레이), (3) presence(TTL 갱신 Redis hash) ([Stack Harbor](https://stackharbor.com/en/knowledge-base/nodejs-websocket-scaling-pattern/)).
- **fan-out 증폭 함정: 방별 채널 구독, wildcard 금지.** `psubscribe('room:*')`는 모든 노드가 모든 방 메시지를 받아 전달량이 노드 수에 대해 **2차(P×N×N)** 로 폭증. 해결: 방의 첫 로컬 멤버 입장 시에만 구독, 마지막 퇴장 시 해제 ([AhsanLab, 2026, 1~8노드 벤치마크](https://tech.ahsanlab.me/posts/scaling-websockets-horizontally-with-redis-pubsub-with-benchmarks)). D3의 방=채널 설계가 미래 Redis 도입 시 지켜야 할 규칙.
- Socket.IO는 5개 공식 어댑터(Redis/Redis Streams/Mongo/Postgres/Cluster) 제공, `io.to('room:42').emit()`이 전역 도달 ([Socket.IO step-9](https://socket.io/docs/v4/tutorial/step-9)). 참조 스택: Node/TS/Redis pub/sub+큐 룸 기반 멀티플레이어 ([TanishValesha/Scalable-Realtime-Multiplayer-System](https://github.com/TanishValesha/Scalable-Realtime-Multiplayer-System)).

## 5. 레거시 공식 포팅 테스트 전략 (D7 검증)

- **golden master = characterization = approval test는 같은 기법의 다른 이름** — 명세가 아니라 *실제* 동작을 포착해 동작 변경 시 실패시킨다. 3단계: (1) 자동 테스트로 편입(의존성 절단이 난제), (2) 출력 포착, (3) 입력 변형으로 시나리오 커버. 의도적 버그 주입으로 최소 1개 테스트가 실제 실패하는지 검증 ([understandlegacycode](https://understandlegacycode.com/blog/characterization-tests-or-approval-tests/); [Wikipedia](https://en.wikipedia.org/wiki/Characterization_test)).
- Michael Feathers(용어 창시, "테스트 없는 코드=레거시")는 **"해야 할 것"이 아니라 "실제 하는 것"을 포착**하는 가설 주도 방식으로 정의 — 관측 출력을 expected로 붙여넣기 ([Michael Feathers](https://michaelfeathers.silvrback.com/characterization-testing)). `legacy/muhan/src`를 behavioral oracle로 쓰는 D7 접근과 정확히 일치.
- **approval 도구가 snapshot/freeze fixture를 자동화하고, "combination approvals"가 공식 입력 공간을 커버** — 다중 파라미터 수치 공식(전투·thaco·마법 테이블)에 적합 ([8th Light](https://8thlight.com/insights/add-approval-testing-to-your-toolbox); [ApprovalTests.com](https://approvaltests.com/); [Codurance](https://www.codurance.com/publications/2012/11/11/testing-legacy-code-with-golden-master)).
- **differential/oracle 대조: 기존 구현을 oracle로 삼아 병렬 실행·발산 저장.** 진짜 위험은 *semantic drift*(컴파일·유닛테스트 통과·성능 향상되지만 로직이 조용히 발산). "동등성 증명이 제품이고 코드는 산출물일 뿐; AI가 oracle을 *운영*하되 oracle *이 되게* 하지 말라" ([Adnan Masood/Medium](https://medium.com/@adnanmasood/architectural-testing-patterns-for-agentic-sdlc-in-legacy-modernization-5e8ffa1e0299), 실무 블로그·부분 페이월). 독립 구현 비교로 편차 검출이 문헌적 정의 ([Emergent Mind](https://www.emergentmind.com/topics/differential-testing); [Gulzar et al. PDF](https://people.cs.vt.edu/~gulzar/assets/pdf/p71-gulzar.pdf)). 무한의 기존 JS 파서 vs C oracle 바이트 diff 검증과 동형.
- **property-based는 수치 공식 범위에 적합하며 결정성이 전제** — 게임엔진 사례가 fast-check로 CI당 2,000~10,000 시드 전투를 돌려 전투 불변식 증명; ambient `Math.random()`/부동소수 drift가 shrinker·리플레이·밸런스 증거를 동시에 파괴("nondeterminism becomes poison") ([Forges of Karinth](https://danjohnson.dev/work/forges-of-karinth), 단일 출처). RNG 시드 고정 + 불변식(데미지≥0, 명중률 범위) assert에 적용.
- **bug-for-bug 호환: forensic 재구성 vs 재구현 두 층.** Fallout2-re는 컴파일러 출력까지 일치시키는 forensic 재구성(reccmp로 함수 diff)이고, OpenTTD/OpenMW는 재구현 ([brightcoding](https://converter.brightcoding.dev/blog/i-reverse-engineered-fallout-2-heres-the-insane-technical-story); [isledecomp/reccmp](https://github.com/isledecomp/reccmp?tab=readme-ov-file)). 무한 포팅(1:1 트랜스파일 아님)의 방침 = **관측 동작을 bug-for-bug 재현(공식·반올림·off-by-one)하되 소프트웨어 형상은 자유 재설계 = binary parity 아닌 behavioral parity.** §1.7 as-shipped 정책과 정확히 일치.
- fixture 유지보수 주의: 큰 공유 fixture는 code smell이 될 수 있으니 **함수별·입력 범위별로 좁게** 유지 ([HN 2024+](https://news.ycombinator.com/item?id=46203948), 포럼·저신뢰). D7의 "frozen 골든 fixture"를 함수 단위로 설계할 근거.

## Key Takeaways

- **D1·D3 정량 확증**: 단일 Node 프로세스가 WS 3만~10만 연결을 처리 → 무한 목표(수십~수백)는 단일 프로세스 + in-process EventEmitter로 압도적 여유, Redis 후순위가 맞다. Colyseus 반려 결정과도 정합(스케일링 문제 자체가 없음).
- **D1 heartbeat 패턴은 DikuMUD 계열의 표준**(단일 타이머 + modulo 서브시스템 분배)이라 무한 A1 구조를 그대로 현대 스케줄러로 옮기면 된다. Evennia 구독 모델·LPMud 시간예산 heartbeat가 "활성 크리처 next-action 큐" refine의 선례.
- **D2 세이브 정책 신규 설계 = 업계 정석과 일치**: 인메모리 권위 + snapshot→queue→async worker + dirty-flag 선택적 개별 비동기 flush. "객체 그래프 말고 값 저장"이 raw-struct→MongoDB 문서 결정을 검증.
- **D4·D8 프로토콜은 정착 패턴 존재**: command/event 계약 분리 + 메시지당 Zod 스키마 + `z.infer` + monorepo 공유 패키지 + `domain:action` discriminator. 손수 구현이 검증된 길이며 프레임워크 불요.
- **D7 = characterization/golden master/oracle 대조의 교과서 적용**: 원본을 behavioral oracle로, frozen fixture는 함수별로, 버그는 §1.7대로 bug-for-bug 재현(behavioral parity). property-based는 RNG 시드 고정 전제로 공식 범위 커버. combination approvals가 다중 파라미터 전투/마법 테이블에 적합.

## Sources

1. [LuminariMUD CORE_SERVER_ARCHITECTURE](https://github.com/LuminariMUD/Luminari-Source/blob/master/docs/systems/CORE_SERVER_ARCHITECTURE.md) — DikuMUD 계열 단일스레드 10pulse/sec 루프 + modulo heartbeat.
2. [ldmud/heartbeat.c](https://github.com/ldmud/ldmud/blob/master/src/heartbeat.c) — LPMud 시간예산·재개형 협력 heartbeat.
3. [Evennia TickerHandler](https://www.evennia.com/docs/latest/Components/TickerHandler.html) — 전역 틱 선택적·구독 모델.
4. [RanvierMUD](https://github.com/RanvierMUD/ranviermud) — 순수 Node.js MUD 엔진.
5. [SO: Node.js/Mongo/Socket.IO game loop](https://stackoverflow.com/questions/32137681/real-time-multiplayer-game-using-node-js-mongodb-and-socket-io-game-loop-and) — 큐 드레인 루프.
6. [SO: MUD timed events](https://stackoverflow.com/questions/2748084/mud-game-design-concept-question-about-timed-events) — ~2초 per-object heartbeat.
7. [Game Programming Patterns: Game Loop](https://gameprogrammingpatterns.com/game-loop.html) — 게임 루프 근본 패턴.
8. [AlgoDaily: Game Server Persistence](https://algodaily.com/lessons/lesson-5-game-server-persistence-083ca31a) — 인메모리 시뮬 + 스냅샷 경계, 값 저장, snapshot→queue→worker.
9. [gamedev.stackexchange: periodic save](https://gamedev.stackexchange.com/questions/31944/best-practices-for-periodically-saving-game-state-to-disk) — dirty-flag 선택적 개별 비동기 autosave.
10. [Player Data Schema MongoDB vs Postgres 2026](https://crux.supercraft.host/blog/player-data-schema-design-nosql-vs-sql/) — DB=진실원천, NoSQL 프로필 (벤더 블로그).
11. [Crux: Persistent Data and Shared State](https://crux.supercraft.host/blog/persistent-data-and-shared-state/) — player-scoped vs project-scoped 분리, 서버 권위 write.
12. [Reintech: MongoDB for Gaming](https://reintech.io/blog/mongodb-for-gaming-storing-querying-player-data) — 인벤토리/통화/업적 임베드.
13. [Ernest.dev: 4X multiplayer](https://ernest.dev/2026/05/31/aonw-how-i-built-multiplayer-for-a-turn-based-4x-game-with-flutter-dart-websockets-and-postgresql/) — 공유 코어 GameCommand/GameEvent, HTTP+WS+event_offset.
14. [RobinTail/zod-sockets](https://github.com/RobinTail/zod-sockets) — Action(incoming)/Emission(outgoing) Zod 검증, 계약 export.
15. [DEV/Nevavuori: shared Zod schemas](https://dev.to/jussinevavuori/end-to-end-typesafe-apis-with-typescript-and-shared-zod-schemas-4jmo) — z.infer/monorepo 공유.
16. [OpenFrontIO Schemas.ts](https://github.com/openfrontio/OpenFrontIO/blob/20bc311c/src/core/Schemas.ts) — Intent discriminated union.
17. [Shoehive command-system](https://github.com/jtay/shoehive/blob/main/docs/pages/api/6_command-system.md) — `domain:action` 래퍼·MessageRouter.
18. [tRPC Discussion #6980](https://github.com/trpc/trpc/discussions/6980) — router in /packages/api, 빌드시 타입 소거 (r/typescript 병기).
19. [SO: Redis pub/sub vs EventEmitter](https://stackoverflow.com/questions/65772945/redis-pub-sub-vs-node-js-eventemitter-for-only-once-processed-events) — in-process once-only vs 크로스노드.
20. [Stack Harbor: WS scaling](https://stackharbor.com/en/knowledge-base/nodejs-websocket-scaling-pattern/) — 3만~10만 conn/process, stickiness/broadcast/presence, Socket.IO Redis adapter.
21. [AhsanLab: Redis pub/sub scaling benchmarks](https://tech.ahsanlab.me/posts/scaling-websockets-horizontally-with-redis-pubsub-with-benchmarks) — wildcard fan-out 증폭, 방별 on-demand 구독.
22. [Socket.IO step-9](https://socket.io/docs/v4/tutorial/step-9) — 5개 공식 어댑터. + 테스트 출처: [understandlegacycode](https://understandlegacycode.com/blog/characterization-tests-or-approval-tests/), [Michael Feathers](https://michaelfeathers.silvrback.com/characterization-testing), [8th Light](https://8thlight.com/insights/add-approval-testing-to-your-toolbox), [ApprovalTests](https://approvaltests.com/), [Codurance](https://www.codurance.com/publications/2012/11/11/testing-legacy-code-with-golden-master), [Adnan Masood](https://medium.com/@adnanmasood/architectural-testing-patterns-for-agentic-sdlc-in-legacy-modernization-5e8ffa1e0299), [Emergent Mind](https://www.emergentmind.com/topics/differential-testing), [Gulzar et al.](https://people.cs.vt.edu/~gulzar/assets/pdf/p71-gulzar.pdf), [Wikipedia Characterization](https://en.wikipedia.org/wiki/Characterization_test), [Forges of Karinth](https://danjohnson.dev/work/forges-of-karinth), [brightcoding Fallout2 RE](https://converter.brightcoding.dev/blog/i-reverse-engineered-fallout-2-heres-the-insane-technical-story), [isledecomp/reccmp](https://github.com/isledecomp/reccmp?tab=readme-ov-file), [HN frozen fixtures](https://news.ycombinator.com/item?id=46203948).

## Methodology

5개 서브질문(런타임 루프/틱, 인메모리↔DB 영속화, WS 프로토콜, pub/sub 채널, 레거시 포팅 테스트)을 3개 병렬 리서치 에이전트로 조사. adapter-exa·adapter-firecrawl 모두 사용(실패 없음). 22개 출처 분석, 핵심 9개 deep-read. 모든 축에서 이슈 #14 확정 결정과 일치하는 선례 확인. 저신뢰 출처(벤더 블로그·포럼·단일 출처)는 본문에 명시 표기.
