# 몬스터 전투 tick 라이브 연결: 리서치 보고서
*Generated: 2026-11-27 | Sources: 9 (deep-read 8) | Adapters: [adapter-exa, adapter-firecrawl] | Failed: 없음*

## Executive Summary

Diku 계열 MUD는 전투 라운드를 **월드 펄스에 묶인 서버 권위 루프**로 돌린다. 한 라운드 안에서 공격 판정, 피해, 사망을 모두 처리하고 결과 문장을 당사자와 방에 바로 보낸다([TelosMUD Wiki](https://double-nibble.com/Combat-System.html), [consolemud combat.md](https://github.com/meistermuka/consolemud/blob/main/docs/combat.md)). 조사한 선례는 공통적으로 피해와 사망을 **단일 관문(funnel)**으로 모은다. 이 관문에서 처리 순서를 고정하고, 사망은 정확히 한 번만 실행되도록 가드를 둔다. 플레이어 사망은 "안전한 방으로 귀환 + 체력 회복"을 최소 구현으로 두고, 장비 낙하·경험치 손실은 나중에 붙이는 규칙 단위로 분리하는 경우가 많다. 조립 순서 문제는 별도 DI 컨테이너 없이 **composition root(엔트리 파일)에서 위상 순서대로 조립**하는 방식이 Node.js에서 권장된다([DEV Community](https://dev.to/emrullah_bozkurt_0ceb498b/composition-root-in-nodejs-dependency-injection-without-a-di-framework-njl), [Martin Fowler — Dependency Composition](https://martinfowler.com/articles/dependency-composition.html)). 서로를 참조해야 하는 경우에는 지연 참조(forward reference)로 순환을 푸는 선례가 있다([NestJS](https://docs.nestjs.com/fundamentals/circular-dependency)).

## 1. 전투 라운드 루프의 구조 (Diku 계열 선례)

- TelosMUD는 250ms 펄스 10개(약 2.5초)를 한 전투 라운드(`PULSE_VIOLENCE`)로 두고, 전투가 시작되면 구역(zone)마다 드라이버를 하나 켠다. 살아 있는 전투자가 없으면 드라이버가 스스로 꺼진다([TelosMUD Wiki](https://double-nibble.com/Combat-System.html)).
- consolemud는 1초 전투 펄스마다 `CombatSystem.Tick`을 실행한다. 대상이 유효한지 확인하고, 기절한 공격자는 건너뛴 뒤 공격을 해결한다([consolemud](https://github.com/meistermuka/consolemud/blob/main/docs/combat.md)).
- 공격 순서를 민첩·무기 속도 기반의 개별 쿨다운으로 바꾸는 CircleMUD 변형도 있다. 이 방식은 매 펄스마다 `NEXT_HIT`를 줄여 가다가 0이 된 개체만 공격하게 한다([CircleMUD rounds.txt](https://www.circlemud.org/pub/CircleMUD/contrib/source/utils/rounds.txt)).
- 재현 가능한 전투를 위해 전투 전용 시드 RNG 하나를 모든 굴림이 공유하게 하고, 테스트에서는 고정 시드로 바꾼다([TelosMUD Wiki](https://double-nibble.com/Combat-System.html)).

**추론(이 저장소 대입)**: 이 저장소의 `creatureTick` 슬롯이 몬스터 케이던스를 맡고, `createCombatTick`이 라운드 하나를 해결하는 구조는 위 선례와 같은 모양이다. 새로 필요한 것은 루프 설계가 아니라 **조립과 결과 전파**다.

## 2. 피해·사망 단일 관문과 정확히 한 번 실행

- TelosMUD는 근접·주문·광역·DoT·기회 공격 등 모든 피해원을 `dealDamage` 한 곳으로 보낸다. `die()`에는 재진입 래치를 둔다. 래치가 없을 때 사망 처리가 다시 실행돼 시체·전리품이 중복되는 결함이 실제로 있었다고 기록한다([TelosMUD Wiki](https://double-nibble.com/Combat-System.html)).
- 같은 문서는 "위치나 자리 정보로 '죽었는가'를 판단하면 안 된다"고 경고한다. 사망한 방이 곧 부활 지점이면 위치가 바뀌지 않아 사망을 놓치기 때문이다. 그래서 사망 횟수 카운터(death generation)로 판정한다([TelosMUD Wiki](https://double-nibble.com/Combat-System.html)).
- consolemud는 `DeathService.HandleDeath` 하나가 플레이어와 NPC 사망을 모두 처리한다. 대상을 0 이하로 떨어뜨릴 수 있는 모든 처리기가 이 함수를 부른다([consolemud](https://github.com/meistermuka/consolemud/blob/main/docs/combat.md)).

**추론**: 이 저장소는 이미 `resolveAttack`을 fire-free로 만들고 `combatTick`이 사망 seam을 실행하는 구조다. 공격 핸들러가 쓰는 `assembleDeathSeams` 인스턴스를 tick도 **같은 참조로** 써야 이 원칙이 유지된다.

## 3. 플레이어 사망 처리의 최소 구현과 분리

- TelosMUD는 플레이어 사망을 "시작 방에서 체력을 가득 채워 부활"로만 구현하고, 시체·경험치 손실·장비 낙하는 나중에 붙일 규칙 손잡이로 미뤘다고 명시한다([TelosMUD Wiki](https://double-nibble.com/Combat-System.html)).
- consolemud도 플레이어 사망은 효과를 지우고 안전한 방으로 체력 1인 채 귀환시키는 것으로 끝낸다([consolemud](https://github.com/meistermuka/consolemud/blob/main/docs/combat.md)).
- 운영 중인 MUD는 시체에 장비를 남기고 회수 명령을 두는 식으로 손실 규칙을 크게 둔다([Rogue Wiki — Death](https://rogue-mud.com/wiki/systems/death/)). 이는 줍기·시체 회수 명령이 있다는 전제 위에서 성립한다.

**추론**: 이 저장소에는 `applyPlayerDeath`(경험치 손실·부활 방·풀회복)가 순수 함수로 이미 있고, 줍기 명령은 아직 없다. 장비 낙하를 지금 넣으면 회수할 수 없는 아이템만 쌓인다. 몬스터 사망 drops를 방에 넣지 않은 기존 결정(D8)과 같은 이유로, 장비 낙하는 범위 밖에 두는 것이 선례와 일관된다.

## 4. 조립 순서와 순환 의존 (composition root)

- Node.js에서는 DI 컨테이너 없이 엔트리 파일(composition root)에서 의존 그래프 전체를 위상 순서대로 조립하는 방식이 권장된다. 타입스크립트에는 런타임 리플렉션이 없어서, 컨테이너를 쓰면 바인딩 누락이 런타임에야 드러나기 때문이다([DEV Community](https://dev.to/emrullah_bozkurt_0ceb498b/composition-root-in-nodejs-dependency-injection-without-a-di-framework-njl)).
- 함수 우선 설계에서는 부분 적용(partial application)으로 문맥을 주입하는 방식이 결합을 줄인다([Martin Fowler — Dependency Composition](https://martinfowler.com/articles/dependency-composition.html)).
- 순환을 피할 수 없을 때 NestJS는 `forwardRef`(지연 참조)로 아직 만들어지지 않은 대상을 가리키게 한다. 다만 기본 원칙은 "가능하면 순환을 피하라"다([NestJS](https://docs.nestjs.com/fundamentals/circular-dependency)).

**추론**: 지금 `index.ts`는 `createWorldRuntime`(onCombatTick 소비자)을 먼저 만들고, 전투 레지스트리·원장·사망 seam은 그 뒤 `buildApp` 안의 `createLiveWorldWiring`에서 만든다. 선택지는 두 가지다.
(a) 전투 원재료를 boot(composition root)로 끌어올려 위상 순서를 바로잡는다.
(b) worldRuntime에 지연 바인딩 seam(나중에 꽂는 onCombatTick)을 둔다.
선례 기준으로는 (a)가 원칙에 맞고, (b)는 예외적 수단이다.

## Key Takeaways

- 루프 자체는 새로 설계하지 않는다. 할 일은 기존 `createCombatTick`을 `createWorldRuntime`에 꽂고, 공격 핸들러와 **같은 인스턴스**(전투 레지스트리·원장 라우터·사망 seam·RNG·now)를 공유하게 만드는 것이다.
- 조립 순서는 composition root(`index.ts`)에서 위상 순서로 푸는 쪽을 우선 검토한다. 지연 바인딩은 차선책이다.
- 플레이어 사망은 이미 이식된 `applyPlayerDeath`(경험치 손실·부활 방·풀회복)로 최소 구현하고, 장비 낙하는 줍기 명령이 생길 때까지 미룬다.
- 사망은 "정확히 한 번" 실행을 테스트로 고정한다. 위치 정보로 사망을 판단하지 않는다.
- 결과 전파(피격 통지, 방 관찰자 통지)는 #186과 경계를 나눠야 한다. 피격 당사자 통지는 이 토픽에서 맡고, 방 관찰자 통지는 #186이 만드는 송신기를 재사용하는 방식이 중복이 적다.

## Sources
1. [TelosMUD Wiki — Combat System](https://double-nibble.com/Combat-System.html) — Diku/ROM 계열 전투 라운드, 피해 단일 관문, 사망 재진입 래치, 최소 플레이어 사망
2. [consolemud — docs/combat.md](https://github.com/meistermuka/consolemud/blob/main/docs/combat.md) — 1초 전투 펄스, 단일 공격 파이프라인, DeathService
3. [CircleMUD contrib — rounds.txt](https://www.circlemud.org/pub/CircleMUD/contrib/source/utils/rounds.txt) — 개체별 공격 쿨다운 변형
4. [Rogue Wiki — Death](https://rogue-mud.com/wiki/systems/death/) — 시체·장비 보존·회수 명령 기반 사망 규칙
5. [Martin Fowler — Dependency Composition](https://martinfowler.com/articles/dependency-composition.html) — 부분 적용 기반 함수 우선 조립
6. [DEV Community — Composition Root in Node.js](https://dev.to/emrullah_bozkurt_0ceb498b/composition-root-in-nodejs-dependency-injection-without-a-di-framework-njl) — 컨테이너 없는 위상 순서 조립
7. [NestJS — Circular dependency](https://docs.nestjs.com/fundamentals/circular-dependency) — forwardRef 지연 참조와 순환 회피 원칙
8. [LuminariMUD — Core Server Architecture](https://github.com/LuminariMUD/Luminari-Source/blob/master/docs/systems/CORE_SERVER_ARCHITECTURE.md) — 단일 스레드 이벤트 루프와 부팅 순서
9. [CircleMUD FAQ](https://www.circlemud.org/cdp/faq/FAQ-6.html) — game_loop 단계 (검색 스니펫만 확인)

## Methodology
검색 쿼리 6개를 실행했다. 사용한 어댑터는 adapter-exa(`/search`, `/contents`)와 adapter-firecrawl(`/v1/search`)이고, 실패한 어댑터는 없다.
조사한 하위 질문은 세 가지다: (1) MUD 전투 라운드 tick 루프 구조, (2) 플레이어 피격·사망 처리와 통지, (3) Node.js composition root·순환 의존 조립.
URL 기준 중복을 제거한 고유 결과 약 80건 중 8건을 본문까지 읽었다. 이 중 단일 출처에만 근거한 주장은 TelosMUD의 사망 재진입 결함 사례(1번)이며, 교차 확인하지 못했다.
