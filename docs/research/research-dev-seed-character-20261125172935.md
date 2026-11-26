# dev 시드 데이터 부트스트랩 패턴: Research Report
*Generated: 2026-11-25 | Sources: 16 | Adapters: [adapter-exa, adapter-firecrawl] | Failed: 없음*

## Executive Summary
개발용 시드 데이터를 넣는 방법은 크게 네 가지다. 앱 부팅 시 시드 함수, 별도 시드 스크립트, DB 초기화 스크립트(`docker-entrypoint-initdb.d`), 테스트 `globalSetup`이다. 부팅 시 시드는 "데이터가 항상 현재 스키마와 맞는다"는 장점이 가장 크게 꼽히고, 대가로 환경 가드를 정확히 걸어야 한다는 점이 공통으로 지적된다 ([Encore](https://encore.dev/articles/seed-database-local-development)). MongoDB에서 "없을 때만 삽입"은 `updateOne(<key>, {$setOnInsert: …}, {upsert: true})`가 표준 관용구이며, 문서가 이미 있으면 아무것도 바꾸지 않는다 ([MongoDB 문서](https://www.mongodb.com/docs/manual/reference/operator/update/setoninsert/)). 파일 기반 픽스처와 init 스크립트는 스키마가 바뀔 때 조용히 낡는다는 점이 반복해서 지적된다 ([Encore](https://encore.dev/articles/seed-database-local-development), [ComfyUI #10707](https://github.com/Comfy-Org/ComfyUI_frontend/issues/10707)).

## 1. 시드 위치별 장단점
- **부팅 시 시드 함수**: 데이터가 현재 스키마와 항상 맞고 별도 도구가 필요 없다. 대신 local·test·preview에서만 돌도록 환경 가드를 정확히 걸어야 한다 ([Encore](https://encore.dev/articles/seed-database-local-development)). EF Core 진영에서도 개발 단계에는 앱 부팅 시 초기화기(initialiser)를 돌리는 방식을 권한다 ([Jason Taylor](https://jasontaylor.dev/ef-core-database-initialisation-strategies/)).
- **우려되는 점**: 공식 문서는 시드 코드를 정상 실행 경로에 두면 여러 인스턴스가 동시에 돌 때 경합이 생길 수 있고, 앱에 쓰기 권한이 필요해진다고 경고한다. 단일 인스턴스나 로컬 환경이면 허용된다는 해석이 일반적이다 ([Stack Overflow](https://stackoverflow.com/questions/61197260/is-it-okay-to-initialize-seed-a-database-data-during-startup-of-an-application)).
- **`docker-entrypoint-initdb.d`**: 데이터 디렉터리가 비어 있는 첫 기동 때만 실행된다. 볼륨이 남아 있으면 다시 돌지 않아 "시드가 안 들어간다"는 문의가 반복된다 ([Stack Overflow](https://stackoverflow.com/questions/77674671/seed-mongodb-not-working-docker-compose), [MongoDB 포럼](https://www.mongodb.com/community/forums/t/usr-local-bin-docker-entrypoint-sh-ignoring-docker-entrypoint-initdb/324741)).
- **테스트 globalSetup**: 테스트 실행 단위의 준비에 적합하다. 다만 테스트 밖에서 스택을 띄우는 개발 흐름은 덮지 못한다 ([QASkills](https://qaskills.sh/blog/vitest-setup-files-vs-global-setup), [Cypress](https://learn.cypress.io/advanced-cypress-concepts/database-initialization-and-seeding)).

## 2. MongoDB 멱등 시딩
- `$setOnInsert`는 `upsert: true`로 문서가 **새로 생길 때만** 필드를 넣고, 기존 문서와 일치하면 아무것도 하지 않는다 ([MongoDB 문서](https://www.mongodb.com/docs/manual/reference/operator/update/setoninsert/)). 시드를 매번 다시 실행해도 기존 데이터가 보존되는 관용구로 쓰인다 ([OneUptime](https://oneuptime.com/blog/post/2026-03-31-mongodb-seed-database-with-test-data/view), [Josh's Notes](https://notes.joshrnoll.com/notes/seeding-a-mongodb-collection-idempotently/)).
- 조회 키(`_id`) 말고 다른 unique 인덱스(예: `name`)와 겹치는 문서가 있으면, upsert라도 `E11000 duplicate key`로 실패한다. 오류가 가리키는 인덱스의 다른 문서를 찾아야 한다 ([Stack Overflow](https://stackoverflow.com/questions/74175751/mongodb-upsert-causing-e11000-duplicate-key-error), [VisuaLeaf](https://visualeaf.com/learn/mongodb/errors/e11000-duplicate-key/)). 동시 upsert 경합에서도 같은 오류가 날 수 있다 ([OneUptime](https://oneuptime.com/blog/post/2025-12-15-mongodb-e11000-duplicate-key-error/view)).

## 3. 시드가 스키마를 따라가게 하기
- 픽스처 파일을 따로 두면 컬럼이나 필드가 바뀔 때 낡는다. 스키마에서 생성하거나 같은 검증기를 통과시키는 방식이 권장된다 ([Encore](https://encore.dev/articles/seed-database-local-development), [fixture-gen](https://arjvand.github.io/fixture-gen/)).
- Zod 타입으로 선언만 하고 **런타임 검증을 하지 않는** 목 데이터는 스키마 변경을 놓친다는 실제 사례가 있다. 해결책은 픽스처를 Zod 스키마로 `parse`하는 테스트를 추가하는 것이었다 ([ComfyUI #10707](https://github.com/Comfy-Org/ComfyUI_frontend/issues/10707)).
- 로컬과 CI의 시드가 같은 단일 출처에서 결정적으로(ID 고정) 나와야 환경 간 차이가 생기지 않는다 ([LocalEnvAuto](https://www.local-environment-automation.com/environment-sync-secrets-ci-parity/database-seeding-and-fixture-parity/)).

## Key Takeaways
- 볼륨 없는 compose mongo에서는 `docker-entrypoint-initdb.d`도 매번 돌긴 하지만, JS 시드가 `Character` 스키마와 따로 놀아 조용히 낡는다. 부팅 시 시드는 스키마 추종과 수동 기동 경로를 함께 해결한다. 이슈 #138의 선택지 1을 뒷받침한다.
- "없을 때만 삽입"은 `_id` 기준 `updateOne` + `$setOnInsert` + `upsert: true`로 구현한다. 개발 중 쌓인 진행 상태가 보존된다.
- 시드 문서를 `characterSchema.parse`로 검증하고 TypeScript 반환 타입을 `Character`로 묶으면, 스키마 변경이 type-check나 부팅 실패로 바로 드러난다.
- `name` unique 인덱스 충돌(E11000)은 삼키지 말고 드러내야 한다. 인메모리 시드 목록과 DB가 어긋났다는 신호이기 때문이다.
- 다중 인스턴스 경합 우려는 단일 프로세스(ADR D1)이고 dev 플래그로 막힌 muhan에는 해당하지 않는다. `$setOnInsert`도 멱등이다.

## Sources
1. [How to Seed a Database for Local Development (2026 Guide) – Encore](https://encore.dev/articles/seed-database-local-development): 시드 방식 비교, 멱등과 환경 가드
2. [Is it okay to seed during Startup? – Stack Overflow](https://stackoverflow.com/questions/61197260/is-it-okay-to-initialize-seed-a-database-data-during-startup-of-an-application): 부팅 시드의 다중 인스턴스 우려
3. [Database Initialisation Strategies for EF Core – Jason Taylor](https://jasontaylor.dev/ef-core-database-initialisation-strategies/): 개발 단계 부팅 초기화기 패턴
4. [Spring Boot Database Initialization](https://docs.spring.io/spring-boot/how-to/data-initialization.html): 프레임워크 내장 부팅 시딩
5. [Vitest Setup Files vs Global Setup – QASkills](https://qaskills.sh/blog/vitest-setup-files-vs-global-setup): globalSetup의 범위
6. [Database Initialization and Seeding – Cypress](https://learn.cypress.io/advanced-cypress-concepts/database-initialization-and-seeding): e2e 시딩 경로
7. [$setOnInsert – MongoDB Manual](https://www.mongodb.com/docs/manual/reference/operator/update/setoninsert/): upsert 시 삽입 전용 필드
8. [How to Seed a MongoDB Database with Test Data – OneUptime](https://oneuptime.com/blog/post/2026-03-31-mongodb-seed-database-with-test-data/view): `$setOnInsert` 멱등 시딩
9. [Seeding a MongoDB Collection Idempotently – Josh's Notes](https://notes.joshrnoll.com/notes/seeding-a-mongodb-collection-idempotently/): 고유 키 기준 upsert
10. [Seed mongodb not working (docker-compose) – Stack Overflow](https://stackoverflow.com/questions/77674671/seed-mongodb-not-working-docker-compose): initdb는 첫 기동만
11. [docker-entrypoint ignoring initdb – MongoDB 포럼](https://www.mongodb.com/community/forums/t/usr-local-bin-docker-entrypoint-sh-ignoring-docker-entrypoint-initdb/324741): 데이터 디렉터리가 있으면 건너뜀
12. [upsert causing E11000 – Stack Overflow](https://stackoverflow.com/questions/74175751/mongodb-upsert-causing-e11000-duplicate-key-error): upsert와 unique 인덱스 충돌
13. [Fix E11000 duplicate key – VisuaLeaf](https://visualeaf.com/learn/mongodb/errors/e11000-duplicate-key/): 오류가 가리키는 인덱스 해석
14. [Fix E11000 – OneUptime](https://oneuptime.com/blog/post/2025-12-15-mongodb-e11000-duplicate-key-error/view): 경합과 unique 인덱스
15. [Zod validation tests for mock fixtures – ComfyUI #10707](https://github.com/Comfy-Org/ComfyUI_frontend/issues/10707): 타입만 있고 런타임 검증 없는 픽스처의 드리프트
16. [Database Seeding and Fixture Parity – LocalEnvAuto](https://www.local-environment-automation.com/environment-sync-secrets-ci-parity/database-seeding-and-fixture-parity/): 결정적 단일 출처 시드

## Methodology
검색 6회(Exa 3, Firecrawl 3)와 Exa `/contents` 본문 읽기 1회(5개 URL). 사용한 어댑터는 adapter-exa와 adapter-firecrawl이고 실패한 어댑터는 없다. 하위 질문은 (1) 시드 위치별 장단점, (2) MongoDB 멱등 시딩과 unique 인덱스 충돌, (3) 스키마 변경을 따라가는 시드 픽스처였다. 분석한 출처는 16개다. Firecrawl의 하위 질문 (3) 결과는 일반적인 Zod 소개 글이 대부분이라 근거로 쓰지 않았다.
