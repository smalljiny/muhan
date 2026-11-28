# 실시간 이벤트 로그 뷰의 상한과 메모이제이션: 리서치 보고서
*Generated: 2026-11-27 | Sources: 9 | Adapters: [adapter-exa, adapter-firecrawl] | Failed: 없음*

## Executive Summary

터미널과 채팅 클라이언트는 수신 기록을 고정 크기 버퍼에 담는 것이 일반적인 관례다. xterm.js의 기본 스크롤백은 1000줄이고, 오래된 줄은 순환 버퍼에서 덮어쓴다. 데스크톱 터미널도 1000~3000줄을 기본값으로 둔다. React에서 목록 끝에 항목을 덧붙이기만 하면 index 키도 문제가 없다. 하지만 상한을 두어 앞쪽 항목을 버리기 시작하면 index가 한 칸씩 밀린다. 그러면 `React.memo`로 감싼 행도 전부 다시 렌더된다. 그래서 항목마다 변하지 않는 키가 필요하다. 수천 줄 규모의 로그 UI는 가상화, 초기 렌더 개수 제한, 렌더 디바운스 가운데 하나 이상을 쓴다. 다만 수백 건 이하에서는 상한과 항목 단위 메모만으로도 충분하다는 사례가 많다. 대형 구조화 페이로드는 로그 뷰어들이 한 줄 요약이나 접힌 트리로 보여 준다.

## 1. 스크롤백 상한 관례

- xterm.js의 기본 `scrollback`은 1000줄이다. 버퍼 길이는 `rows + scrollback`이고, 순환 목록(CircularList)이 가장 오래된 줄을 덮어쓴다. 무한 스크롤백은 메모리 문제로 지원하지 않는다는 것이 메인테이너의 답변이다([DeepWiki: xterm.js Terminal Buffer System](https://deepwiki.com/xtermjs/xterm.js/3.1-terminal-buffer-system), [xterm.js #518](https://github.com/xtermjs/xterm.js/issues/518)).
- xterm.js를 쓰는 ttyd도 기본 1000줄을 그대로 쓴다([ttyd #134](https://github.com/tsl0922/ttyd/issues/134)). Neovim 터미널 버퍼의 기본값은 1024줄이다([Stack Overflow](https://stackoverflow.com/questions/34009064/how-do-i-set-the-terminal-buffer-scrollback-size)). 일부 터미널은 3000줄을 기본으로 두고 1000~10000 사이에서 바꾸게 한다([maiTerm](https://maiterm.dev/features/terminal/)).
- MUD 클라이언트 zMUD는 큰 스크롤백 버퍼를 위해 메모리 설정 페이지를 따로 둔다. 스크롤백 크기가 메모리와 맞바꾸는 값이라는 뜻이다([zMUD Memory](https://www.zuggsoft.com/zmud/help7/memory_pref.htm)).
- 채팅 위젯 Deep Chat은 브라우저 저장 기록의 `maxMessages` 기본값을 1000으로 둔다([Deep Chat docs](https://deepchat.dev/docs/messages/)).

## 2. React 목록의 키와 메모이제이션

- React 공식 문서는 배열 index 대신 데이터에서 나온 안정적인 키를 쓰라고 한다. 항목이 삽입·삭제·재정렬되면 index 키는 다른 항목을 같은 것으로 착각하게 만든다([react.dev: Rendering Lists](https://react.dev/learn/rendering-lists)).
- 끝에 덧붙이기만 하는 목록에서는 index 키로도 기존 항목이 그대로 매칭된다. React의 재조정(reconciliation)은 끝에 자식을 추가하는 경우를 효율적으로 처리한다([legacy React: Reconciliation](https://legacy.reactjs.org/docs/reconciliation.html)).
- 앞쪽에서 행을 지우면 `React.memo` 행이 전부 다시 렌더된다는 질문이 있다. 답변은 키를 `map` 단계에서 행 자체의 안정 id로 주라는 것이다([Stack Overflow #69916489](https://stackoverflow.com/questions/69916489/react-memo-rerenders-subsequent-table-rows-when-adding-or-deleting-from-table-start)). 상한 버퍼에서 앞쪽 항목을 버리는 상황이 바로 이 경우다.

## 3. 대규모 로그 렌더링 사례

- Qovery의 로그 UI는 세션당 수천~1만 줄을 다룬다. 가상화는 높이가 제각각인 여러 줄 로그에 맞지 않아 쓰지 않았다. 대신 WebSocket 수신을 1초 단위로 묶어 렌더하고, 처음에는 마지막 500줄만 렌더했다. 렌더 시간이 1084ms에서 108ms로 줄었다고 보고한다([Qovery](https://www.qovery.com/blog/building-performant-logs-interface)).
- 라이브 채팅 피드 실험에서는 단순 `map` 렌더로 약 3700건이 쌓이자 30fps 아래로 떨어졌다. `react-window` 가상화를 쓰자 DOM 노드 14개로 60fps를 유지했다고 보고한다. 단일 개인 실험이므로 미검증으로 본다([DEV Community](https://dev.to/shrutictc2/how-i-kept-a-live-chat-feed-smooth-at-3700-messages-1kf6)).
- web.dev는 큰 목록에서 화면에 보이는 행만 렌더하는 가상화(windowing)를 권장한다([web.dev](https://web.dev/articles/virtualize-long-lists-react-window)).

## 4. 대형 구조화 페이로드 표현

- JSON 로그 뷰어들은 원시 JSON을 그대로 쌓지 않는다. 한 줄 요약을 보여 주고 필요할 때 트리로 펼치게 한다([LogViewPlus](https://www.logviewplus.com/support/1078/Display-JSON-as-Collapsible-Tree), [hl](https://github.com/pamburus/hl)). 둘 다 제품 문서라 일반 관례로만 참고한다.

## Key Takeaways

- 상한은 수백~1000건 범위가 관례다. 렌더 비용은 DOM 노드 수에 비례하므로, 가상화를 쓰지 않는 로그라면 수백 건 수준이 안전하다.
- 앞쪽을 버리는 상한 버퍼에는 항목별로 변하지 않는 키(단조 증가 시퀀스 등)가 반드시 필요하다. 그래야 `React.memo` 행 메모가 동작한다.
- 상한과 메모로 충분하면 가상화·디바운스는 도입하지 않아도 된다. 가상화는 높이가 다른 행에서 비용이 크다.
- 이미 다른 패널이 보여 주는 대형 페이로드는 로그에 한 줄 요약으로 표시하는 편이 관례에 맞다.

## Sources

1. [DeepWiki: xterm.js Terminal Buffer System](https://deepwiki.com/xtermjs/xterm.js/3.1-terminal-buffer-system): 기본 scrollback 1000, 순환 버퍼
2. [xterm.js #518](https://github.com/xtermjs/xterm.js/issues/518): 무한 스크롤백 미지원 이유
3. [ttyd #134](https://github.com/tsl0922/ttyd/issues/134): xterm.js 기본값 1000 사용
4. [maiTerm Terminal](https://maiterm.dev/features/terminal/): 기본 3000줄, 1000~10000 설정
5. [Deep Chat Messages](https://deepchat.dev/docs/messages/): maxMessages 기본 1000
6. [react.dev: Rendering Lists](https://react.dev/learn/rendering-lists): 안정 키 원칙
7. [Stack Overflow #69916489](https://stackoverflow.com/questions/69916489/react-memo-rerenders-subsequent-table-rows-when-adding-or-deleting-from-table-start): 앞쪽 삭제 시 memo 행 재렌더
8. [Qovery: Building a performant logs interface](https://www.qovery.com/blog/building-performant-logs-interface): 500줄 초기 렌더, 1초 디바운스
9. [DEV: Live chat feed at 3,700+ messages](https://dev.to/shrutictc2/how-i-kept-a-live-chat-feed-smooth-at-3700-messages-1kf6): 가상화 전후 fps

## Methodology

검색 쿼리 5개를 실행했다. 사용한 어댑터는 adapter-exa(`/search` auto, `/contents`)와 adapter-firecrawl(`/v1/search`)이고, 실패한 어댑터는 없다. 하위 질문은 세 가지였다. (1) 터미널·MUD·채팅 클라이언트의 스크롤백 상한 관례, (2) React 안정 키와 React.memo 행 메모이제이션, (3) 대형 로그·JSON 페이로드 렌더링 선례. 본문 6건을 읽었다.
