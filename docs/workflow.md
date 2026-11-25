# 작업 흐름 — 하네스 토픽 worktree

토픽은 `/flow-*` 하네스로 진행한다. 스펙은 주 worktree에서 확정하고, 계획부터 PR까지는 토픽마다 격리된 git worktree의 별도 Claude 세션에서 진행한다. 주 worktree는 늘 `develop`에 둔다.

용어는 README의 위계(**에픽** → **토픽** → Story)를 따른다. 토픽 1개 = 이슈 1개 = PR 1개다.

## 하네스 설치

하네스(`.claude/`, `.harness/`, `.codex/`, `AGENTS.md`, `CLAUDE.md`)는 이 저장소가 추적하지 않는다(`.gitignore`). 하네스 저장소의 배포 스크립트로 주 worktree에 설치하거나 갱신한다.

```bash
<하네스 저장소>/scripts/deploy-harness.sh /Users/mario/Workspace/mario/muhan
```

- 설치 뒤 한 번: `/flow-init`(CLAUDE.md·AGENTS.md의 프로젝트 섹션), `/flow-setup git`(원격·기준 브랜치 `develop`)
- 커밋 scope 목록은 `.harness/commit-scopes.md`에 있고, 재배포해도 덮어쓰지 않는다.
- 토픽 worktree에는 `/flow-worktree`가 하네스를 주입한다(`.claude` 등은 링크, `.harness`·`docs/_local`은 복사). worktree에서 따로 설치하지 않는다.

## 흐름

| 단계 | 위치 | 명령 | 산출물 |
|---|---|---|---|
| 1. 스펙 | 주 worktree | `/flow-spec <토픽>` | `docs/_local/backlog/<토픽>/spec.md` (추적 안 함), Codex 스펙 리뷰 → 확정 |
| 2. worktree 시작 | 주 worktree | `/flow-worktree <토픽>` | `muhan.worktrees/<토픽>`, 브랜치 `feature/<토픽>`, cmux 새 칸에서 worktree 세션 |
| 3. 계획 | 토픽 worktree | `/flow-plan` | Task 단위 구현 계획, Codex 계획 리뷰 |
| 4. 구현 | 토픽 worktree | `/flow-impl` (반복) | Task별 커밋 |
| 5. 리뷰·검증 | 토픽 worktree | `/flow-review`, `/flow-verify` | 코드 리뷰, 빌드·테스트·보안 검증 |
| 6. 문서 | 토픽 worktree | `/flow-docs` | 스펙을 구현에 맞추고 `docs/specs/`에 반영해 커밋 |
| 7. PR | 토픽 worktree | `/flow-pr` → 사용자 병합 → `/flow-done` | `develop` 대상 PR, 토픽 산출물 아카이브 |
| 8. 정리 | 주 worktree | `/flow-worktree teardown <토픽> --delete-branch` | 문서 sync-back, worktree·브랜치 삭제 |

- 토픽 이름은 `^[a-zA-Z0-9_-]+$`이고, 이슈를 다루는 토픽은 이슈 번호를 스펙에 남긴다. PR 본문에는 `Closes #<이슈>`를 적는다.
- 주 worktree는 `/flow-spec`과 `/flow-worktree`(시작·정리)만 맡는다. 토픽의 다른 `/flow-*`를 주 worktree에서 실행하면 토픽 상태(`docs/_local/dev-context.json`)의 격리가 깨진다.
- 언제든 `/flow-topic`으로 현재 토픽의 단계를 확인한다.

## 스펙의 두 단계

- **토픽 스펙** — `docs/_local/backlog/<토픽>/spec.md`. 작업 중 계약을 담는 초안이고 추적하지 않는다. 확정 뒤 worktree로 복사되고, 끝나면 `docs/_local/done/`에 보관된다.
- **기준 스펙** — `docs/specs/*.md`. 프로젝트 최종 상태와 항상 일치하는 문서다. `/flow-docs`가 구현을 마친 시점에 토픽 스펙을 반영하므로 코드와 같은 PR로 병합된다.

## 이 저장소의 규칙

- **로드맵(`docs/roadmap/roadmap.html`)은 토픽 PR에서 고치지 않는다.** 여러 토픽이 동시에 고치면 충돌하므로, 병합 뒤 주 worktree가 한꺼번에 갱신한다.
- 범위 밖에서 찾은 결함은 고치지 않고 새 이슈로 남긴다. 만들기 전에 같은 내용의 열린 이슈가 있는지 확인한다.
- 원본 오라클(`legacy/muhan`)은 읽기만 한다.

## 병렬 토픽의 주의점

- **turbo 캐시는 worktree끼리 공유된다** (turbo 2.x 기본, `docs/specs/monorepo.md`). 해시가 같으면 다른 worktree의 결과를 재생하는 것이 정상이다.
- **`node_modules`는 worktree마다 따로 설치된다.** pnpm 스토어를 공유하므로 설치는 빠르다.
- **docker compose는 한 번에 하나의 worktree에서만 띄운다.** 포트(`3000`, `27017`)가 고정이라 두 스택이 동시에 뜨지 않는다. 다른 worktree에서 띄우기 전에 `docker compose down`한다.
- **공유 계약은 토픽끼리 충돌한다.** `PROTOCOL_VERSION`, `schemaVersion`, `shared/protocol`의 판별 유니온을 함께 바꾸는 토픽은 동시에 진행하지 않거나, 먼저 병합된 쪽 위로 rebase한 뒤 번호를 다시 올린다.
