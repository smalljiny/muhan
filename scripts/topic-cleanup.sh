#!/usr/bin/env bash
# 병합된 토픽의 worktree·로컬 브랜치·cmux 작업 공간을 정리한다.
#
#   scripts/topic-cleanup.sh <짧은 이름>
#   예) scripts/topic-cleanup.sh dev-seed-character
#
# 주 worktree에서 실행한다 (docs/workflow.md §병합 뒤 정리).
# 다음 중 하나라도 맞지 않으면 아무것도 지우지 않고 끝난다.
#   - 브랜치가 origin/develop에 병합돼 있다
#   - worktree에 커밋하지 않은 변경이나 무시되지 않은 미추적 파일이 없다
# 원격 브랜치는 GitHub의 병합 후 자동 삭제에 맡기고, 여기서는 참조만 정리한다.
set -euo pipefail

[ $# -eq 1 ] || {
  echo "사용법: $0 <짧은 이름>" >&2
  exit 2
}
name=$1

main=$(git worktree list --porcelain | awk 'NR==1 && $1=="worktree" { sub(/^worktree /, ""); print; exit }')
here=$(git rev-parse --show-toplevel)
if [ "$here" != "$main" ]; then
  echo "주 worktree($main)에서 실행해야 한다 (현재 $here)" >&2
  exit 3
fi
dir="$(dirname "$main")/$(basename "$main")-$name"
branch=$(git for-each-ref --format='%(refname:short)' "refs/heads/*/$name")
if [ -z "$branch" ] || [ "$(printf '%s\n' "$branch" | wc -l)" -ne 1 ]; then
  echo "짧은 이름이 ${name}인 로컬 브랜치를 하나로 특정하지 못했다: ${branch:-없음}" >&2
  exit 3
fi

git fetch --quiet --prune origin
if ! git merge-base --is-ancestor "$branch" origin/develop; then
  echo "${branch}가 origin/develop에 병합되지 않았다. PR을 먼저 병합한다." >&2
  exit 3
fi

if [ -d "$dir" ]; then
  dirty=$(git -C "$dir" status --porcelain)
  if [ -n "$dirty" ]; then
    echo "worktree에 커밋하지 않은 파일이 있어 지우지 않는다: $dir" >&2
    echo "$dirty" >&2
    exit 3
  fi
fi

# cmux 작업 공간: 작업 디렉터리가 이 worktree 아래인 것을 닫는다.
if command -v cmux >/dev/null 2>&1 && cmux identify --json >/dev/null 2>&1; then
  cmux workspace list --json | DIR="$dir" python3 -I -c '
import json, os, sys
d = os.environ["DIR"]
for w in json.load(sys.stdin)["workspaces"]:
    cwd = w.get("current_directory") or ""
    if cwd == d or cwd.startswith(d + "/"):
        print(w["ref"])
' | while IFS= read -r ws; do
    cmux workspace close "$ws" && echo "cmux 작업 공간을 닫았다: $ws"
  done
fi

if [ -d "$dir" ]; then
  git worktree remove "$dir"
  echo "worktree를 지웠다: $dir"
else
  git worktree prune
fi
git branch -d "$branch" >/dev/null 2>&1 || git branch -D "$branch" >/dev/null
echo "로컬 브랜치를 지웠다: $branch"

if [ "$(git branch --show-current)" = develop ]; then
  git pull --quiet --ff-only && echo "develop을 $(git rev-parse --short HEAD)로 갱신했다"
fi
