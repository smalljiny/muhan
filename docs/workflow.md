# 작업 흐름 — 토픽 worktree

토픽 하나를 별도 git worktree와 cmux 작업 공간에서 새 Claude 세션으로 진행한다. 여러 토픽을 서로 간섭 없이 병렬로 진행하고, 주 worktree는 늘 `develop`에 둔다.

용어는 README의 위계(**에픽** → **토픽** → Story)를 따른다. 토픽 1개 = 이슈 1개 = 스펙 1개 = PR 1개다.

## 역할

| 자리 | 위치 | 하는 일 |
|---|---|---|
| **주 worktree** (조정 세션) | `/Users/mario/Workspace/mario/muhan`, 항상 `develop` | 다음 토픽 선정, 토픽 시작, 병합 뒤 정리, 로드맵 갱신 |
| **토픽 worktree** (토픽 세션) | `<주 worktree>-<짧은 이름>`, 토픽 브랜치 | 스펙 작성, 구현, 검증, PR |

주 worktree에서는 코드를 고치지 않는다. 문서만 바꾸는 작업도 토픽으로 시작한다.

## 이름 규칙

| 대상 | 형식 | 예 |
|---|---|---|
| 브랜치 | `<type>/<짧은 이름>` | `feature/dev-seed-character` |
| worktree | `<주 worktree 경로>-<짧은 이름>` (type 접두사를 뗀다) | `/Users/mario/Workspace/mario/muhan-dev-seed-character` |
| cmux 작업 공간 | 이름 `<짧은 이름>`, 설명 `#<이슈> · <브랜치>` | `dev-seed-character` |

- `type`은 `feature`·`fix`·`chore` 중 하나다.
- 짧은 이름은 `^[a-z0-9]+(-[a-z0-9]+)*$`에 맞고 40자 이하다.
- worktree 이름에서 type을 떼므로, 짧은 이름은 type이 달라도 겹치면 안 된다. 시작 스크립트가 겹치는 이름을 거부한다.

## 토픽 시작 (주 worktree)

```bash
scripts/topic-start.sh <type> <짧은 이름> [이슈 번호]
# 예
scripts/topic-start.sh feature dev-seed-character 138
```

스크립트가 하는 일:

1. 이슈가 열려 있는지 확인한다.
2. `origin/develop`을 가져와 그 위에 브랜치와 worktree를 만든다.
3. 무시된 로컬 env 파일(`.env*`, `packages/*/.env*`)을 새 worktree로 복사한다.
4. 호출한 cmux 작업 공간이 속한 그룹("무한대전")에 새 작업 공간을 만든다. 그룹 이름은 `CMUX_TOPIC_GROUP`으로 바꿀 수 있다.
5. 새 작업 공간에서 `pnpm install --frozen-lockfile`을 실행한 뒤, `claude`를 "docs/workflow.md를 읽고 이슈 #N 토픽을 시작해"라는 첫 프롬프트와 함께 띄운다.

cmux 밖에서 실행하면 worktree까지만 만들고 수동 실행 명령을 출력한다.

## 토픽 진행 (토픽 세션)

### 1. 파악

- 이슈 본문의 문제, 할 일, 완료 기준을 읽는다. 이슈가 **무엇을 왜** 하는지의 기준이다.
- 관련 스펙(`docs/specs/`), 분석 노트(`docs/notes/`), 원본 오라클(`legacy/muhan/src`)을 확인한다. 오라클은 읽기만 한다.
- 이슈가 결정을 요구하면(예: 선택지 1·2·3) 스펙을 쓰기 전에 사용자와 정한다.

### 2. 스펙 — 토픽 브랜치의 첫 커밋

- 새 서브시스템이면 `docs/specs/<토픽>.md`를 만들고, 기존 서브시스템을 넓히면 그 스펙을 고친다.
- 스펙에는 목표와 범위(Non-goals 포함), 계약(프로토콜·스키마·seam), 오라클 대조 근거, 완료 기준과 검증 방법, 유예 항목과 그 추적 이슈를 적는다. 기존 스펙의 구성과 `docs/glossary.md`의 용어를 따른다.
- `docs(specs): …` 커밋으로 남기고, **사용자 확인을 받은 뒤** 구현을 시작한다.

스펙을 토픽 브랜치에서 쓰는 이유: `docs/specs/`는 프로젝트 최종 상태와 항상 일치해야 한다. 스펙과 코드를 한 PR로 리뷰하고 병합하면 `develop`의 스펙이 코드보다 앞서거나 뒤처지는 기간이 생기지 않는다.

### 3. 구현

- Story(단일 커밋) 단위로 커밋한다. 제목은 Conventional Commits 형식에 한국어 요약이다. 예: `feat(server): 부팅 시 dev 시드 캐릭터를 upsert한다`
- 구현 중 스펙과 달라지는 결정은 스펙에도 바로 반영한다.
- 범위 밖에서 찾은 결함은 고치지 않고 새 이슈로 남긴다. PR 본문 `Refs`에 적는다.

### 4. 검증

```bash
pnpm build && pnpm type-check && pnpm lint && pnpm test
```

전송·세션 경로를 바꿨으면 README의 e2e 절차도 실행한다. 실행하지 않은 검증은 PR에 그 사실과 이유를 적는다.

### 5. 마무리와 PR

- 스펙을 최종 구현 상태에 맞추고, 새 스펙이면 README의 문서 안내 표와 스펙 개수를 갱신한다.
- `git push -u origin <브랜치>` 후 `develop`을 대상으로 PR을 연다. 본문은 기존 기능 PR(예: #148)의 구성(변경사항·목적·영향 범위·테스트·알려진 범위 경계·관련 이슈)을 따르고, `Closes #<이슈>`와 `Refs #…`를 적는다.
- **로드맵(`docs/roadmap/roadmap.html`)은 토픽 PR에서 고치지 않는다.** 여러 토픽이 동시에 고치면 충돌하므로, 병합 뒤 주 worktree가 한꺼번에 갱신한다.
- 병합은 사용자가 GitHub에서 한다.

## 병합 뒤 정리 (주 worktree)

```bash
scripts/topic-cleanup.sh <짧은 이름>
```

브랜치가 `origin/develop`에 병합됐고 worktree에 커밋하지 않은 파일이 없을 때만 다음을 한다.

1. 그 worktree를 작업 디렉터리로 쓰는 cmux 작업 공간을 닫는다.
2. worktree와 로컬 브랜치를 지운다.
3. `develop`을 fast-forward한다.

조건이 하나라도 맞지 않으면 아무것도 지우지 않는다. 원격 브랜치 삭제는 GitHub에 맡긴다.

## 병렬 토픽의 주의점

- **turbo 캐시는 worktree끼리 공유된다** (turbo 2.x 기본, `docs/specs/monorepo.md`). 해시가 같으면 다른 worktree의 결과를 재생하는 것이 정상이다.
- **`node_modules`는 worktree마다 따로 설치된다.** pnpm 스토어를 공유하므로 설치는 빠르다.
- **docker compose는 한 번에 하나의 worktree에서만 띄운다.** 포트(`3000`, `27017`)가 고정이라 두 스택이 동시에 뜨지 않는다. 다른 worktree에서 띄우기 전에 `docker compose down`한다.
- **공유 계약은 토픽끼리 충돌한다.** `PROTOCOL_VERSION`, `schemaVersion`, `shared/protocol`의 판별 유니온을 함께 바꾸는 토픽은 동시에 진행하지 않거나, 먼저 병합된 쪽 위로 rebase한 뒤 번호를 다시 올린다.
