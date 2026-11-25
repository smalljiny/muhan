#!/usr/bin/env bash
# 토픽 worktree를 만들고 cmux 작업 공간에서 새 Claude 세션을 연다.
#
#   scripts/topic-start.sh <type> <짧은 이름> [이슈 번호]
#   예) scripts/topic-start.sh feature dev-seed-character 138
#
# 하는 일 (docs/workflow.md §토픽 시작):
#   1. 원격 develop을 가져와 <type>/<짧은 이름> 브랜치와
#      <주 worktree>-<짧은 이름> worktree를 만든다.
#   2. 무시된 로컬 env 파일(.env*)을 새 worktree로 복사한다.
#   3. 호출한 cmux 작업 공간이 속한 그룹(없으면 CMUX_TOPIC_GROUP 이름의 그룹)에
#      새 작업 공간을 만들고, pnpm install 뒤 claude를 첫 프롬프트와 함께 실행한다.
#      cmux 밖에서 실행하면 worktree만 만들고 수동 실행 명령을 출력한다.
set -euo pipefail

usage() {
  echo "사용법: $0 <feature|fix|chore> <짧은 이름> [이슈 번호]" >&2
  exit 2
}

[ $# -ge 2 ] && [ $# -le 3 ] || usage
type=$1
name=$2
issue=${3:-}

case "$type" in feature | fix | chore) ;; *)
  echo "type은 feature·fix·chore 중 하나여야 한다: $type" >&2
  exit 2
  ;;
esac
if ! [[ "$name" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || [ ${#name} -gt 40 ]; then
  echo "짧은 이름은 소문자·숫자·하이픈(^[a-z0-9]+(-[a-z0-9]+)*$), 40자 이하여야 한다: $name" >&2
  exit 2
fi
if [ -n "$issue" ] && ! [[ "$issue" =~ ^[0-9]+$ ]]; then
  echo "이슈 번호는 숫자여야 한다: $issue" >&2
  exit 2
fi

# 주 worktree = `git worktree list`의 첫 항목. 토픽 worktree에서 실행해도 기준은 같다.
main=$(git worktree list --porcelain | awk 'NR==1 && $1=="worktree" { sub(/^worktree /, ""); print; exit }')
[ -n "$main" ] || {
  echo "주 worktree를 찾지 못했다" >&2
  exit 1
}
branch="$type/$name"
dir="$(dirname "$main")/$(basename "$main")-$name"

if [ -e "$dir" ]; then
  echo "worktree 경로가 이미 있다: $dir" >&2
  exit 3
fi
# 디렉터리 이름에서 type을 떼므로, 짧은 이름이 같은 브랜치는 type이 달라도 거부한다.
clash=$(git -C "$main" for-each-ref --format='%(refname:short)' \
  "refs/heads/*/$name" "refs/remotes/origin/*/$name")
if [ -n "$clash" ]; then
  echo "짧은 이름이 같은 브랜치가 이미 있다:" >&2
  echo "$clash" >&2
  exit 3
fi
if [ -n "$issue" ]; then
  state=$(gh issue view "$issue" --json state --jq .state 2>/dev/null || true)
  if [ "$state" != "OPEN" ]; then
    echo "이슈 #${issue}가 열려 있지 않거나 읽을 수 없다 (state=${state:-?})" >&2
    exit 3
  fi
fi

if git -C "$main" fetch --quiet origin develop; then
  base=origin/develop
else
  echo "경고: origin develop을 가져오지 못해 로컬 develop에서 만든다" >&2
  base=develop
fi
git -C "$main" worktree add --quiet -b "$branch" "$dir" "$base"
echo "worktree: $dir"
echo "branch:   $branch (기준 $base $(git -C "$dir" rev-parse --short HEAD))"

# 무시된 env 파일은 worktree에 따라오지 않으므로 복사한다.
(cd "$main" && git ls-files --others --ignored --exclude-standard -- '.env*' 'packages/*/.env*') |
  while IFS= read -r f; do
    mkdir -p "$dir/$(dirname "$f")"
    cp -p "$main/$f" "$dir/$f"
    echo "env 복사: $f"
  done

if [ -n "$issue" ]; then
  prompt="docs/workflow.md를 읽고 그 절차대로 이슈 #$issue 토픽을 시작해. 이 worktree의 브랜치는 ${branch}다."
  desc="#$issue · $branch"
else
  prompt="docs/workflow.md를 읽고 그 절차대로 이 토픽을 시작해. 이 worktree의 브랜치는 ${branch}다. 먼저 무엇을 할지 나에게 물어봐."
  desc="$branch"
fi
# 새 셸이 해석하므로 프롬프트를 작은따옴표로 감싼다 (프롬프트에 작은따옴표를 넣지 않는다).
cmd="pnpm install --frozen-lockfile && claude '$prompt'"

if ! command -v cmux >/dev/null 2>&1 || ! cmux identify --json >/dev/null 2>&1; then
  echo
  echo "cmux 밖에서 실행했다. 새 터미널에서 다음을 실행한다:"
  echo "  cd '$dir' && $cmd"
  exit 0
fi

group=$(
  CMUX_TOPIC_GROUP=${CMUX_TOPIC_GROUP:-무한대전} python3 -I -c '
import json, os, subprocess
ident = json.loads(subprocess.check_output(["cmux", "identify", "--json"]))
me = (ident.get("caller") or {}).get("workspace_ref")
groups = json.loads(subprocess.check_output(["cmux", "workspace-group", "list", "--json"]))["groups"]
mine = [g for g in groups if me in g.get("member_workspace_refs", [])]
named = [g for g in groups if g.get("name") == os.environ["CMUX_TOPIC_GROUP"]]
pick = (mine or named or [None])[0]
print(pick["ref"] if pick else "")
'
)

args=(new-workspace --name "$name" --description "$desc" --cwd "$dir" --command "$cmd")
if [ -n "$group" ]; then
  args+=(--group "$group" --group-placement end)
else
  echo "경고: cmux 그룹을 찾지 못해 그룹 없이 작업 공간을 만든다 (CMUX_TOPIC_GROUP=${CMUX_TOPIC_GROUP:-무한대전})" >&2
fi
cmux "${args[@]}"
echo "cmux 작업 공간을 만들었다: $name ${group:+(그룹 $group)}"
