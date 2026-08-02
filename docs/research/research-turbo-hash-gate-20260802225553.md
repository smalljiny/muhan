# Turborepo 태스크 해시 입력과 worktree 캐시 공유: Research Report
*Generated: 2026-08-02 | Sources: 8 | Adapters: [exa] | Failed: 없음 | 대상 이슈: #126*

## Executive Summary

이슈 #126이 보고한 "게이트 거짓 통과"는 turbo의 버그가 아니라 **문서화된 오설정**이다. Turborepo 공식 문서는 `check-types`(우리의 `type-check`)를 `dependsOn` 없이 정의하는 것을 `// Incorrect!`로 명시하고, 그 결과가 정확히 "상위 패키지 인터페이스를 깨뜨려도 하위 앱이 cache hit"임을 예시로 든다 ([Configuring Tasks](https://turborepo.dev/docs/crafting-your-repository/configuring-tasks)). 처방은 둘이다 — `dependsOn: ["^type-check"]`(정확하지만 직렬화) 또는 **Transit Node** 패턴(정확 + 병렬 유지).

worktree 간 캐시 공유는 우연이나 오염이 아니라 **turbo가 의도적으로 넣은 기능**이다. 2026-01-09 머지된 [PR #11416](https://github.com/vercel/turborepo/pull/11416)이 linked worktree의 캐시를 main worktree의 `.turbo/cache`로 리다이렉트하며, 출력의 `using shared worktree cache` 문구가 그 신호다. 즉 공유 자체를 버그로 볼 근거는 없고, **해시가 불완전한 상태에서 공유가 켜져 있어 오탐이 가시화**된 것이다. 공유를 끄는 스위치는 `cacheDir` 명시다(문서상 명시 시 공유 비활성).

현장 실측에서 이슈 본문이 적지 않은 **두 번째 구멍**이 확인됐다: 루트 `eslint.config.js`·`tsconfig.base.json`은 어느 태스크의 해시 입력에도 들어가지 않아, 규칙 파일을 바꿔도 전 태스크가 cache hit한다. 이는 `globalDependencies` 미설정 때문이며 `dependsOn` 수정으로는 해소되지 않는다.

## 1. turbo가 태스크 해시에 넣는 것

Turborepo는 **global hash**와 **task hash** 두 개를 만들고 둘 중 하나만 바뀌어도 cache miss가 난다 ([Caching](https://turborepo.dev/docs/crafting-your-repository/caching)).

**Global hash 입력** — 루트·패키지 `turbo.json`의 해소된 태스크 정의, 워크스페이스 루트에 영향을 주는 lockfile 변경, **루트 `package.json`이 (전이적으로) 의존하는 내부 패키지의 소스**, `globalDependencies`에 나열된 파일 내용, `globalEnv` 변수 값, 런타임에 영향을 주는 플래그, passthrough 인자.

**Package hash 입력** — 패키지 자신의 `turbo.json`, 그 패키지에 영향을 주는 lockfile 변경, 패키지 `package.json`, 그리고 **기본적으로 패키지 디렉터리 안의 source-controlled 파일 전부**(`inputs`로 조정).

핵심은 마지막 줄이다. 패키지 해시는 **자기 디렉터리 안**만 본다. 따라서 `dependsOn`이 비어 있으면 상위 패키지의 소스 변경은 하위 패키지 태스크의 해시에 어떤 경로로도 들어가지 않는다. 루트에 있는 설정 파일(`eslint.config.js`, `tsconfig.base.json`)도 어느 패키지 디렉터리에도 속하지 않으므로 `globalDependencies`에 명시하지 않는 한 해시 밖이다.

## 2. type-check·lint의 정본 처방 — Transit Node

공식 문서는 우리 상황을 그대로 다룬다 ([Configuring Tasks §Dependent tasks that can be run in parallel](https://turborepo.dev/docs/crafting-your-repository/configuring-tasks)):

```json
{ "tasks": { "check-types": {} } }   // Incorrect!
```

> This runs your tasks in parallel — but doesn't account for source code changes in dependencies. This means you can: 1. Make a breaking change to the interface of your `ui` package. 2. Run `turbo check-types`, hitting cache in an application package that depends on `ui`. **This is incorrect**, since the application package will show a successful cache hit, despite not being updated to use the new interface.

처방 1 — 위상 의존:

```json
{ "tasks": { "check-types": { "dependsOn": ["^check-types"] } } }  // 정확하지만 직렬
```

처방 2 — Transit Node (정확 + 병렬):

```json
{
  "tasks": {
    "transit": { "dependsOn": ["^transit"] },
    "check-types": { "dependsOn": ["transit"] }
  }
}
```

Transit Node는 어느 `package.json`에도 없는 이름이라 실제로 실행되는 스크립트가 없다. 그런데도 태스크 그래프에 패키지 의존 관계를 주입해 **해시에는 상위 패키지가 반영되되 실행은 병렬로 남는다**. 문서는 이름을 `transit`으로 예시하되 워크스페이스의 기존 스크립트명과 충돌하지 않는 아무 이름이나 쓸 수 있다고 명시한다.

`type-check`가 상위 패키지의 **빌드 산출물**(`dist/*.d.ts`)을 읽는 저장소라면 `^build`가 추가로 필요하지만, 이 저장소는 `packages/{server,client}/tsconfig.json`의 `paths`가 `shared` → `../shared/src/index.ts`(소스)로 매핑돼 있어 dist를 읽지 않는다. 따라서 `^build`는 불필요하고 `^type-check`/transit로 충분하다.

## 3. worktree 캐시 공유는 turbo의 의도된 기능이다

2023년 이슈 [#5217 "Cache Miss with Git Worktrees"](https://github.com/vercel/turborepo/issues/5217)는 정반대 불만이었다 — linked worktree에서 **해시가 동일한데도 cache miss가 난다**. 논의 [#7884](https://github.com/vercel/turborepo/discussions/7884)로 전환돼 "worktree는 비교적 마이너해서 우선순위가 낮다"는 응답을 받았으나, 2025년 들어 "worktree는 Claude Code 워크플로우에서 무시할 수 없는 부분이 됐다"는 요청이 누적됐고, 2026-01-09 [PR #11416 "feat: Git worktree support"](https://github.com/vercel/turborepo/pull/11416)가 머지됐다.

PR이 명시한 동작:

- linked worktree를 감지하면 캐시를 **main worktree의 `.turbo/cache`로 리다이렉트**한다.
- 출력에 `using shared worktree cache` 메시지를 띄운다 — 이슈 #126이 관측한 바로 그 문구다.
- **명시적 `cacheDir` 설정이 항상 우선한다** — 설정하면 worktree 공유가 비활성화되고 각 worktree가 자기 캐시를 갖는다.
- 동시성 안전을 위해 캐시 쓰기를 atomic(temp 기록 후 rename)으로 구현했다.

공식 문서도 같은 내용을 §Git Worktree Cache Sharing으로 싣는다 ([Caching](https://turborepo.dev/docs/crafting-your-repository/caching)). 즉 **worktree 간 replay는 설계된 동작이며, 그 전제는 "해시가 같으면 산출물은 교환 가능하다"**이다. 우리 저장소에서 그 전제가 깨진 것은 공유 때문이 아니라 해시가 불완전하기 때문이다.

## 4. 실측 — 이 저장소에서의 재현 (2026-08-02, turbo 2.10.2, develop `18ac42f`)

**(a) 삭제된 worktree의 로그가 replay된다**

`develop`(main hub)에서 `pnpm turbo run type-check` 실행 시 3개 태스크 전부 cache hit이며, 로그 경로가 `/Users/mario/Workspace/muhan.worktrees/world-view/packages/...`였다. 이 worktree는 같은 세션에서 이미 제거된 디렉터리다.

**(b) 상위 패키지 소스 변경이 하위 태스크 해시에 반영되지 않는다**

`packages/shared/src/index.ts`에 export 한 줄 추가 후:

```
shared:type-check: cache miss, executing e33b10c14969d73e
server:type-check: cache hit, replaying logs 4d2ab1b025de0a40
client:type-check: cache hit, replaying logs df4ebcbfdf0414b1

shared:lint:        cache miss, executing bb5dfb26e3c442da
server:lint:        cache hit, replaying logs f643f575319df0f7
client:lint:        cache hit, replaying logs cb02917d575c1f16
@muhan/port:lint:   cache hit, replaying logs 64e7308eac3596cc
```

이슈 본문의 진단이 그대로 재현된다. `lint`도 동일하게 뚫린다 — 루트 `eslint.config.js`가 `projectService: true`(타입 인지)라 lint 역시 상위 패키지 타입을 읽는데도 해시는 자기 패키지만 본다.

**(c) 루트 설정 파일 변경이 어떤 해시에도 들어가지 않는다 (이슈 본문 미기재)**

```
루트 eslint.config.js 변경 → lint       4/4 cache hit
루트 tsconfig.base.json 변경(noUnusedLocals 추가) → type-check  3/3 cache hit
```

`tsconfig.base.json`은 전 패키지의 컴파일러 옵션 원천이고 `eslint.config.js`는 전 패키지의 lint 규칙 원천인데, 둘 다 어느 패키지 디렉터리에도 속하지 않아 해시 밖이다. **규칙을 강화해도 검증이 한 번도 돌지 않는다.**

## Key Takeaways

- `type-check`·`lint`의 `dependsOn: []`는 turbo 문서가 `// Incorrect!`로 못 박은 안티패턴이다. 처방은 `^<task>` 또는 Transit Node이며, 후자가 병렬성을 지킨다.
- 이 저장소는 `paths`로 `shared/src`를 직접 참조하므로 `^build`는 불필요하다 — `dist`를 읽지 않는다.
- worktree 캐시 공유는 turbo 2.x의 의도된 기능(PR #11416)이다. 끄는 방법은 `cacheDir` 명시이며, 이는 해시 결함을 고치는 게 아니라 관측을 막는 완화책이다.
- 이슈 #126이 적지 않은 두 번째 구멍이 있다 — 루트 `eslint.config.js`·`tsconfig.base.json`이 `globalDependencies` 미설정으로 해시 밖이다. `dependsOn` 수정만으로는 닫히지 않는다.
- 진단 도구가 존재한다: `turbo run <task> --summarize`가 태스크별 해시 입력 전체를 덤프하고, 두 summary 비교로 "왜 해시가 같은가"를 규명할 수 있다. 완료 조건의 재현 테스트를 이 위에 세울 수 있다.

## Sources

1. [Caching — Turborepo Docs](https://turborepo.dev/docs/crafting-your-repository/caching) — global/package 해시 입력 표, §Git Worktree Cache Sharing, `--summarize` 진단
2. [Configuring Tasks — Turborepo Docs](https://turborepo.dev/docs/crafting-your-repository/configuring-tasks) — `^` 마이크로신택스, `// Incorrect!` 예시, Transit Node 패턴
3. [Configuring turbo.json — Turborepo Docs](https://turborepo.dev/docs/reference/configuration) — `globalDependencies`·`globalEnv`·`inputs`·`cacheDir` 레퍼런스
4. [PR #11416 feat: Git worktree support](https://github.com/vercel/turborepo/pull/11416) — worktree 캐시 공유 구현·`cacheDir` 우선 규칙 (머지 2026-01-09)
5. [Issue #5217 Cache Miss with Git Worktrees](https://github.com/vercel/turborepo/issues/5217) — 공유 이전의 반대 증상(worktree마다 cache miss)
6. [Discussion #7884 Support Git Worktrees](https://github.com/vercel/turborepo/discussions/7884) — 우선순위 논의와 사용자 요구 누적 경과
7. [skills/turborepo/references/caching/gotchas.md](https://github.com/vercel/turbo/blob/main/skills/turborepo/references/caching/gotchas.md) — 캐싱 함정 모음
8. 로컬 실측 — `muhan` develop `18ac42f`, turbo 2.10.2, 2026-08-02

## Methodology

Exa `/search` 3회(해시 입력 시맨틱 / type-check·lint 위상 의존 / worktree 캐시 공유 오탐), `/contents` 1회(6 URL 배치 심층 읽기). 어댑터 실패 없음. Firecrawl은 Exa 결과가 1차 출처(공식 문서·머지된 PR·이슈 원문)를 모두 덮어 추가 호출하지 않았다. 웹 조사 결과는 로컬 저장소 실측 3건(위 §4)으로 교차 검증했으며, 실측이 이슈 본문에 없던 루트 설정 파일 구멍을 추가로 드러냈다.
