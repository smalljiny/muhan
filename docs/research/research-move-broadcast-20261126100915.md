# 방 단위 입·퇴장 통지 패턴: Research Report
*Generated: 2026-11-26 | Sources: 14 | Adapters: [adapter-exa, adapter-firecrawl] | Failed: 없음*

## Executive Summary
MUD 계열 서버는 이동 한 번에 **출발 방의 나머지 점유자에게 퇴장 메시지, 도착 방의 나머지 점유자에게 입장 메시지**를 보내고, 이동 주체 본인은 별도 메시지(새 방 설명)를 받는다 ([TinyMUX](https://www.tinymux.org/wiki/topics/moving/), [CircleMUD 메일링 리스트](https://www.circlemud.org/maillist/1996-11/0170.html)). 은신(sneak)이나 어두운 상태면 입·퇴장 메시지를 억제하는 조건이 이동 루틴 안에 직접 들어 있다. 실시간 웹 서버 쪽에서는 "처음에 전체 스냅샷, 이후 변경분(델타) 스트림" 조합이 표준이며, 델타는 추가·갱신·**삭제**를 모두 표현해야 하고 스냅샷과 델타의 순서가 섞이지 않아야 한다 ([matthewcm.dev](https://matthewcm.dev/notes/snapshot-and-delta-sync-over-websockets/), [LiteEntitySystem](https://revenantx.github.io/LiteEntitySystem/articles/sync/how-state-syncs.html)). 수신자별 가시성(은신·투명)은 클라이언트에서 숨기는 것이 아니라 **서버가 아예 보내지 않는 것**이 보안 속성이라는 점이 공통으로 강조된다 ([PlayServ](https://docs.playserv.io/sdk/v2/the-live-game/rooms/visibility), [Multiplay Guide](https://multiplayguide.com/blog/multiplayer-interest-management-player-trust)).

## 1. MUD의 이동 메시지 관례
- TinyMUX는 출구로 이동할 때 이동자에게 SUCC, 출발 방의 다른 점유자에게 OSUCC를 보낸다. 이동자와 출발 방이 어둡지 않을 때만 퇴장 메시지(OLEAVE, 기본 "`<이름>` has left.")를 보내고, 도착 방의 다른 점유자에게는 입장 메시지(OXENTER 등)를 보낸다. 이동자 본인은 새 방의 설명(DESC)을 받는다 ([TinyMUX MOVING](https://www.tinymux.org/wiki/topics/moving/)).
- CircleMUD는 `do_simple_move`에서 `if (!IS_AFFECTED(ch, AFF_SNEAK)) act("$n has arrived.", ..., TO_ROOM)`처럼 **은신 상태면 도착 메시지를 아예 보내지 않는다**. 도착 방향("from the north")은 출구 방향의 반대 방향으로 계산한다 ([CircleMUD 메일링 리스트](https://www.circlemud.org/maillist/1996-11/0170.html)).
- MUSH·MUCK 계열도 출구와 방에 입·퇴장 메시지 속성을 두고 "이동자 외 점유자"에게 보내는 구조가 같다 ([AuroraMUSH 매뉴얼](https://aurora.matrixnetwork.co.uk/manual.html), [Tricks of the Internet Gurus](https://www.rigacci.org/docs/biblio/online/iguru/tig11.htm), [BTMux move.cpp](http://svn.code.sf.net/p/btonline-btech/code/legacy/btmux-gluereimpl/move.cpp)).

## 2. 스냅샷과 델타
- 처음에는 전체 스냅샷을 보내고, 이후에는 변경분만 보내는 방식이 일반적이다. 클라이언트가 너무 뒤처지면 새 스냅샷으로 다시 맞춘다 ([LiteEntitySystem](https://revenantx.github.io/LiteEntitySystem/articles/sync/how-state-syncs.html), [Irurueta Docs](https://www.irurueta.com/web/webrtc-websockets/multiplayer-game-architecture.html)).
- 델타에는 추가·갱신·삭제가 모두 있어야 한다. 갱신만 있으면 사라진 항목이 목록에 남는다. 새 스냅샷은 기준을 새로 잡으며, 오래된 델타가 새 스냅샷을 덮어쓰지 않도록 순서(시퀀스)를 지켜야 한다 ([matthewcm.dev](https://matthewcm.dev/notes/snapshot-and-delta-sync-over-websockets/)).
- 상태 값("지금 무엇인가")과 사건("무슨 일이 있었나")은 구분해야 한다. 사건이 중요하면 상태 동기화에 기대지 말고 별도 이벤트로 보낸다. 엔터티의 생성·소멸도 같은 순서 보장 스트림에 넣어, 클라이언트가 존재하지 않는 엔터티의 데이터를 보는 일이 없게 한다 ([LiteEntitySystem](https://revenantx.github.io/LiteEntitySystem/articles/sync/how-state-syncs.html)).
- 방 단위 소규모(수십 명)에서는 방 전체 스냅샷을 모두에게 보내는 방식으로 충분하다는 실무 기준이 있다 ([PlayServ](https://docs.playserv.io/sdk/v2/the-live-game/rooms/visibility)).

## 3. 수신자별 가시성
- 가시성 필터는 "누가 무엇을 받는가"를 서버에서 수신자마다 판정한다. 숨겨야 할 정보는 클라이언트에서 감추는 것이 아니라 패킷에 넣지 않아야 한다 ([PlayServ](https://docs.playserv.io/sdk/v2/the-live-game/rooms/visibility), [netfox](https://foxssake.github.io/netfox/latest/netfox/guides/visibility-management/), [PurrNet](https://purrnet.dev/docs/systems-and-modules/network-manager/network-visibility)).
- 특정 관찰자에게 특정 플레이어를 숨기는 API(관찰자 × 대상)를 두는 사례가 있다 ([KCD Multiplayer](https://docs.kcd-mp.com/lua/server/functions/setplayerinvisiblefor/)).
- 관련성 규칙은 대역폭뿐 아니라 신뢰의 문제다. 정보가 늦게 나타나거나 새면 플레이어는 게임이 거짓말을 한다고 느낀다 ([Multiplay Guide](https://multiplayguide.com/blog/multiplayer-interest-management-player-trust)).

## Key Takeaways
- 입·퇴장 통지의 수신자는 "출발 방의 나머지 점유자"와 "도착 방의 나머지 점유자"이고, 이동 주체는 제외한다. 은신 같은 상태는 이동 루틴 안에서 통지 자체를 억제한다. 원본(오라클)의 정확한 조건은 `legacy/muhan/src`에서 대조해야 한다.
- muhan은 이미 `world:room` 방 전체 스냅샷을 쓴다. 방 인원이 적으므로, 이동 때 영향받는 점유자에게 갱신 스냅샷을 다시 보내는 방식도 업계 기준상 타당하다. 다만 "누가 들어왔다/나갔다"는 사건은 스냅샷으로는 표현되지 않으므로 사건 이벤트가 따로 필요하다.
- 스냅샷과 사건 이벤트를 함께 보내면 순서를 정해야 한다(예: 사건 → 갱신 스냅샷). 클라이언트가 둘을 섞어 잘못된 목록을 그리지 않게 한다.
- 은신·투명 점유자의 입·퇴장은 수신자별로 서버에서 걸러야 한다. muhan에는 이미 관찰자를 받지 않는 `projectRoomView` 문제(#129)가 있으므로, 이번 범위에서 가시성 필터를 어디까지 다룰지 정해야 한다.

## Sources
1. [MOVING – TinyMUX](https://www.tinymux.org/wiki/topics/moving/): 이동 시 메시지와 수신자 순서
2. [CircleMUD List: Leave / Arrive question](https://www.circlemud.org/maillist/1996-11/0170.html): `AFF_SNEAK` 도착 메시지 억제, 도착 방향 계산
3. [AuroraMUSH Manual](https://aurora.matrixnetwork.co.uk/manual.html): 입·퇴장 메시지 속성
4. [Tricks of the Internet Gurus ch.11](https://www.rigacci.org/docs/biblio/online/iguru/tig11.htm): MUD/MUCK 입·퇴장 메시지
5. [BTMux move.cpp](http://svn.code.sf.net/p/btonline-btech/code/legacy/btmux-gluereimpl/move.cpp): 퇴장 처리 구현
6. [Snapshot and Delta Sync over WebSockets – matthewcm.dev](https://matthewcm.dev/notes/snapshot-and-delta-sync-over-websockets/): 스냅샷·델타 순서와 삭제 델타
7. [How state gets to clients – LiteEntitySystem](https://revenantx.github.io/LiteEntitySystem/articles/sync/how-state-syncs.html): 기준 스냅샷·델타, 상태와 사건의 구분
8. [Multiplayer Game Architecture – Irurueta Docs](https://www.irurueta.com/web/webrtc-websockets/multiplayer-game-architecture.html): 방 상태 동기화 방식 비교
9. [Visibility – PlayServ.io](https://docs.playserv.io/sdk/v2/the-live-game/rooms/visibility): 방 전체 전송과 수신자별 전송, 비노출은 보안 속성
10. [Visibility Management – netfox](https://foxssake.github.io/netfox/latest/netfox/guides/visibility-management/): 수신자별 가시성 필터
11. [Network Visibility – PurrNet](https://purrnet.dev/docs/systems-and-modules/network-manager/network-visibility): 관찰자 기반 전송 제어
12. [SetPlayerInvisibleFor – KCD Multiplayer](https://docs.kcd-mp.com/lua/server/functions/setplayerinvisiblefor/): 관찰자별 플레이어 숨김
13. [Interest Management Is a Trust System – Multiplay Guide](https://multiplayguide.com/blog/multiplayer-interest-management-player-trust): 관련성 규칙과 신뢰
14. [Interest management – Lightyear](https://cbournhonesque.github.io/lightyear/book/concepts/advanced_replication/interest_management.html): 수신자별 복제 범위

## Methodology
검색 6회(Exa 3, Firecrawl 3)와 Exa `/contents` 본문 읽기 1회(6개 URL). 사용한 어댑터는 adapter-exa와 adapter-firecrawl이고 실패한 어댑터는 없다. 하위 질문은 (1) MUD의 입·퇴장 메시지와 은신 억제, (2) 방 상태 스냅샷과 델타 이벤트의 순서 일관성, (3) 수신자별 가시성 필터였다. 분석한 출처는 14개다. Firecrawl 결과는 일반 용어 사전이나 Minecraft 플러그인처럼 관련성이 낮은 항목이 많아 대부분 근거로 쓰지 않았다. muhan 원본(오라클)의 실제 동작은 이 보고서 범위 밖이며 스펙 작성 때 `legacy/muhan/src`에서 직접 대조한다.
