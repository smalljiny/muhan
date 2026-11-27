# deps-audit: 의존성 취약점 해소 리서치 보고서
*작성: 2026-11-26 | 출처: 12 | 어댑터: adapter-exa, adapter-firecrawl | 실패: 없음*

## Executive Summary

Vitest 4는 Tinypool을 완전히 제거하고 풀 구현을 새로 작성했다([Vitest 마이그레이션 가이드](https://v4.vitest.dev/guide/migration)). 따라서 `vitest>tinypool` critical 2건은 4.x로 올리면 의존 자체가 사라져 해소된다. 같은 가이드에 따르면 v4는 `coverage.all`을 제거했다. 이 저장소의 vitest 설정 4개가 모두 `all: true`를 쓰므로 함께 정리해야 하지만, `coverage.include`를 이미 지정하고 있어 커버리지 대상 범위는 유지된다. `@typescript-eslint/unbound-method`의 테스트 오탐은 널리 알려진 문제이고, 공식 대안은 테스트 파일에서 이 규칙을 끄고 `vitest/unbound-method`(expect 호출 인지 확장판)로 교체하는 것이다([eslint-plugin-vitest](https://github.com/vitest-dev/eslint-plugin-vitest/blob/main/docs/rules/unbound-method.md)). pnpm 메인테이너는 취약점 대응의 1순위로 overrides가 아닌 `pnpm update -r`을 권장한다. 다만 사용하지 않게 된 overrides를 자동으로 정리하는 기능은 pnpm에 아직 없다([pnpm#9852](https://github.com/pnpm/pnpm/issues/9852)).

## 1. Vitest 3 → 4 마이그레이션

- **Tinypool 제거**: "In Vitest v4 we've completely removed Tinypool and rewritten how pools work without new dependencies"([마이그레이션 가이드](https://v4.vitest.dev/guide/migration)). 이 저장소의 측정 결과(vitest 4.1.12 설치 후 `pnpm audit` 0건)와 일치한다. vitest 3.2.7이 tinypool·@vitest/mocker 권고를 마지막까지 안고 있었다는 외부 사례도 있다([Gitea 커밋 77a99e8](https://git.svc.zoit.services/Green-Tea/core/commit/77a99e83ce52d995dc1027237f447da483ba1c97)). 단일 출처이므로 참고용이다.
- **풀 옵션 재편**: `poolOptions` 제거, `maxThreads`/`maxForks`가 `maxWorkers`로 통합, `minWorkers` 제거([마이그레이션 가이드](https://v4.vitest.dev/guide/migration)). 이 저장소 설정에는 풀 옵션이 없어 영향이 없다.
- **커버리지**: `coverage.all`·`coverage.extensions`·`coverage.ignoreEmptyLines`가 제거됐다. "it is recommended to define `coverage.include`"([마이그레이션 가이드](https://v4.vitest.dev/guide/migration)). 이 저장소는 루트와 패키지 3곳 모두 `all: true`와 `include`를 함께 쓴다. `include`가 있으므로 커버리지 대상은 유지되고, `all` 키만 지우면 된다(추론).
- **`workspace` → `projects`**: 3.2에서 이름이 바뀌었다([마이그레이션 가이드](https://v4.vitest.dev/guide/migration)). 이 저장소는 이미 `projects`를 쓴다.
- **mock 동작 변경**: `vi.restoreAllMocks`가 `vi.spyOn`으로 만든 spy만 복원한다. `getMockName()` 기본값이 `vi.fn()`으로 바뀌었다. 생성자 mock은 `function`이나 `class` 키워드로 구현해야 한다([마이그레이션 가이드](https://v4.vitest.dev/guide/migration)).
- **mock 타입**: v4의 `vi.fn` 시그니처는 `fn(fn?: Procedure | Constructable): Mock`이다([Vi API](https://v4.vitest.dev/api/vi)). 타입 인자 없이 만든 mock을 구체 함수 타입 자리에 넣으면 할당 오류가 난다는 보고가 있다([vitest#8803](https://github.com/vitest-dev/vitest/issues/8803)). 가이드는 `Mock<(name: string) => number>`처럼 함수 타입을 제네릭으로 주는 형태를 예시로 든다([마이그레이션 가이드](https://v4.vitest.dev/guide/migration)).

## 2. `@typescript-eslint/unbound-method`와 Vitest mock 단언

- 이 규칙은 `recommended-type-checked`에 포함되고, 메서드를 객체에서 떼어 쓰면 보고한다([typescript-eslint](https://typescript-eslint.io/rules/unbound-method/)).
- 테스트의 `expect(obj.method).toHaveBeenCalled()` 오탐은 오래된 문제다([Stack Overflow](https://stackoverflow.com/questions/59134100/can-no-unbound-method-be-whitelisted-for-unittests-is-there-any-possibility-o), [Solvro#450](https://github.com/Solvro/lib-web-solvro-config/issues/450)). 의존성 인터페이스의 콜백 메서드에서 이 오탐이 난다는 사례 보고도 있다([Stack Overflow for Agents](https://agents.stackoverflow.com/tils/f52c93b9-24e0-41dd-9479-869756913829?tag=vitest)).
- **공식 대안**: `@vitest/eslint-plugin`의 `vitest/unbound-method`는 기본 규칙을 확장해 "when it's ok to pass an unbound method to `expect` calls"를 인지한다. 권장 설정은 테스트 파일에서 `@typescript-eslint/unbound-method`를 끄고 이 규칙을 켜는 것이다([eslint-plugin-vitest 문서](https://github.com/vitest-dev/eslint-plugin-vitest/blob/main/docs/rules/unbound-method.md)). `vi.mocked`에 넘기는 함수를 무시하도록 고쳤고([#849](https://github.com/vitest-dev/eslint-plugin-vitest/issues/849)), 2026-03에 규칙이 재활성화됐다([#883](https://github.com/vitest-dev/eslint-plugin-vitest/pull/883)).
- **8.62 → 8.74 사이 변경**: changelog에 `unbound-method` 관련 수정이 여러 건 있다. 8.70.1(Intl.Collator), 8.71.0(`this: void` 클래스 속성)이다([CHANGELOG](https://github.com/typescript-eslint/typescript-eslint/blob/main/packages/eslint-plugin/CHANGELOG.md)). 함수 타입 속성 시그니처까지 보고하자는 제안 PR([#11682](https://github.com/typescript-eslint/typescript-eslint/pull/11682), 이슈 [#3503](https://github.com/typescript-eslint/typescript-eslint/issues/3503))도 있다. 이 저장소 70건의 원인이 어느 변경인지는 **확인하지 못했다**(버전 이분 탐색 필요).

## 3. pnpm overrides·업데이트 전략

- pnpm 공식 문서는 먼저 `pnpm update`를 시도하고, 그래도 남으면 overrides나 `pnpm audit --fix`를 쓰라고 안내한다([pnpm audit](https://pnpm.io/cli/audit)).
- 메인테이너도 "an override is not always needed. Sometimes a targeted update is enough: `pnpm update -r`"라고 답했다. 오래된 overrides를 자동으로 정리하는 기능은 요청만 있고 구현되지 않았다([pnpm#9852](https://github.com/pnpm/pnpm/issues/9852), [pnpm#5949](https://github.com/pnpm/pnpm/issues/5949)). 외부 도구로 `pnpm-override-prune`, `scan-overrides`가 있다([pnpm-override-prune](https://github.com/iwamot/pnpm-override-prune), [scan-overrides](https://github.com/shtbik/scan-overrides/)).
- 범위 선택자 overrides(`"pkg@<x": ">=x"`)는 취약 버전에만 적용되지만, 여전히 계속 남아 있으므로 트리가 자연 해소되면 지워야 한다. pnpm 11부터 overrides는 `pnpm-workspace.yaml`에 둔다([charpeni.com](https://charpeni.com/blog/surgical-transitive-updates-with-pnpm-audit-fix)). 이 저장소는 pnpm 10.33이라 `package.json`의 `pnpm.overrides`를 유지한다.

## Key Takeaways

- vitest는 4.1.12 이상으로 올린다. tinypool 의존이 사라지는 것이 critical 해소의 유일한 경로다.
- vitest 설정 4곳에서 `coverage.all`을 지운다. `include`가 있으므로 커버리지 범위는 그대로다.
- 테스트의 `vi.fn()`은 대상 함수 타입을 제네릭으로 준다(`vi.fn<OnWriteSettled>()`).
- unbound-method 오탐은 테스트 파일에서 기본 규칙을 끄는 방식과 `vitest/unbound-method`로 교체하는 방식 중 하나로 대응한다. 후자는 `@vitest/eslint-plugin` 의존이 하나 늘어난다.
- overrides는 범위 내 갱신 후 감사 결과로 하나씩 필요성을 확인해 지운다. 자동 정리 도구는 공식 지원되지 않는다.

## Sources

1. [Vitest 4 Migration Guide](https://v4.vitest.dev/guide/migration) — v4 breaking change 공식 목록
2. [Vitest Vi API](https://v4.vitest.dev/api/vi) — v4 `vi.fn` 시그니처
3. [vitest#8803](https://github.com/vitest-dev/vitest/issues/8803) — v4 mock 타입 호환 문제 보고
4. [Gitea 커밋 77a99e8](https://git.svc.zoit.services/Green-Tea/core/commit/77a99e83ce52d995dc1027237f447da483ba1c97) — vitest 4 업그레이드로 tinypool 권고 해소 사례
5. [typescript-eslint unbound-method](https://typescript-eslint.io/rules/unbound-method/) — 규칙 정의
6. [typescript-eslint CHANGELOG](https://github.com/typescript-eslint/typescript-eslint/blob/main/packages/eslint-plugin/CHANGELOG.md) — 8.6x~8.74 변경 이력
7. [typescript-eslint#11682](https://github.com/typescript-eslint/typescript-eslint/pull/11682) — 함수 타입 속성 보고 확장 제안
8. [eslint-plugin-vitest unbound-method](https://github.com/vitest-dev/eslint-plugin-vitest/blob/main/docs/rules/unbound-method.md) — expect 인지 확장 규칙
9. [eslint-plugin-vitest#883](https://github.com/vitest-dev/eslint-plugin-vitest/pull/883) — 규칙 재활성화
10. [pnpm audit](https://pnpm.io/cli/audit) — 공식 대응 순서
11. [pnpm#9852](https://github.com/pnpm/pnpm/issues/9852) — overrides 정리 기능 부재와 메인테이너 권고
12. [charpeni.com — pnpm audit --fix](https://charpeni.com/blog/surgical-transitive-updates-with-pnpm-audit-fix) — 범위 선택자 overrides와 `--fix=update`

## Methodology

검색 쿼리 8회(Exa 5, Firecrawl 3). 어댑터: adapter-exa, adapter-firecrawl. 실패한 어댑터 없음. 하위 질문: (1) Vitest 3→4 breaking change와 mock 타입, (2) unbound-method와 Vitest mock 단언 대응, (3) pnpm overrides·업데이트 전략. 원문 정독 7건(Exa `/contents`). 저장소 측정값(감사 결과·게이트 결과)은 #144 2026-11-26 코멘트에서 가져왔고, 외부 출처와 구분해 표기했다.
