# 릴리스와 버전

## 버전 체계

- 저장소 전체에 SemVer 태그 하나를 쓴다: `vMAJOR.MINOR.PATCH`.
- 버전 숫자는 루트 `package.json`에만 적는다. workspace 패키지(`server`·`client`·`shared`·`port`)는 `private`이고 함께 배포되므로 `0.0.0`으로 둔다.
- 태그는 주석 태그(`git tag -a`)로 만들고 `main`에만 붙인다.

### 1.0 이전 규칙

| 시점 | 버전 |
|---|---|
| 로드맵 체크포인트 통과 (CP1, CP2, CP3 …) | MINOR 증가 — CP1 = `v0.1.0`, CP2 = `v0.2.0` |
| `main`의 결함 수정 | PATCH 증가 — `v0.1.1` |
| 외부 테스터용 사전 배포 | pre-release 접미사 — `v0.2.0-rc.1` |
| 원작과 기능이 동등해지고 공개 운영 시작 | `v1.0.0` |

### 프로토콜 버전

`packages/shared/src/protocol/version.ts`의 `PROTOCOL_VERSION`은 클라이언트와 서버의 호환 계약이다. 앱 버전과 별개로, 프로토콜이 바뀔 때마다 1씩 올린다. 릴리스 노트에 해당 릴리스의 프로토콜 버전을 적는다.

## 절차

브랜치는 git flow를 따른다 (`main` = production, `develop` = 통합).

### 정기 릴리스

1. `develop`에서 `release/<버전>` 브랜치를 만든다.
2. 루트 `package.json`의 `version`을 올리고 `docs/roadmap/roadmap.html`을 릴리스 상태로 갱신한다.
3. `release/<버전>` → `main` PR을 만들어 병합한다 (merge commit).
4. `main`의 병합 커밋에 주석 태그 `v<버전>`을 붙이고 push한다.
5. GitHub 릴리스를 만든다: `gh release create v<버전> --generate-notes`. 자동 노트 위에 체크포인트 요약, 프로토콜 버전, 알려진 제약을 덧붙인다.
6. `main`을 `develop`에 역병합한다.

### 핫픽스

1. `main`에서 `hotfix/<버전>` 브랜치를 만든다.
2. 수정과 함께 `package.json`의 PATCH를 올린다.
3. `main`에 병합하고 태그를 붙인 뒤 GitHub 릴리스를 만든다.
4. `main`을 `develop`에 역병합한다.

## 릴리스 이력

| 버전 | 날짜 | 체크포인트 | 프로토콜 |
|---|---|---|---|
| v0.1.0 | 2026-11-27 | CP1 걸어볼 수 있는 무한 | 7 |
