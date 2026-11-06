#!/bin/bash
# Runs on a Docker host. A volume with a project from before isolation goes through the real
# entrypoint, then a real worktree is created, committed to and destroyed through the CLI, which
# reaches git through the real isolation provider. Needs HTTPS access to github.com.
# Usage: acceptance-upgrade.sh <image>
set -u
IMAGE=$1
V=archon-upgrade-$$
C=archon-upgrade-$$
S=/.archon/workspaces/octocat/Hello-World/source
OLD=/.archon/workspaces/octocat/Hello-World/worktrees/old
rc=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; rc=1; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1: expected [$3], got [$2]"; fi; }
cleanup() { docker rm -f "$C" >/dev/null 2>&1; docker volume rm "$V" "$V-agent" >/dev/null 2>&1; }
trap cleanup EXIT

# The shape a 0.13.2 install leaves: everything appuser:appuser, default modes.
docker run --rm --entrypoint bash -v "$V:/.archon" "$IMAGE" -c "
  set -e
  mkdir -p $(dirname $S)
  git clone -q https://github.com/octocat/Hello-World.git $S
  mkdir -p $S/.archon/workflows
  echo secret > /.archon/.env
  cat > $S/.archon/workflows/up.yaml <<'YAML'
name: up
description: upgrade flow
nodes:
  - id: work
    bash: |
      id -u > /tmp/up-uid-\$\$
      id -u > uid
      echo x > made-by-agent
      git add made-by-agent
      git commit -qm made-by-agent
      git log -1 --format=%s > subject
YAML
  git -C $S add .archon
  git -C $S -c user.name=a -c user.email=a@a commit -qm workflow
  git -C $S push -q . HEAD:refs/heads/master 2>/dev/null || true
  git -C $S worktree add -q -b old-work $OLD
  chown -R appuser:appuser /.archon
" || { bad 'seeding failed'; exit 1; }

docker run -d --name "$C" -e ARCHON_DOCKER=true -e ARCHON_AGENT_USER=archon-agent -e PORT=3090 \
  -v "$V:/.archon" -v "$V-agent:/home/archon-agent" "$IMAGE" >/dev/null
for _ in $(seq 60); do
  docker exec "$C" curl -fs localhost:3090/api/health >/dev/null 2>&1 && break
  sleep 2
done
if docker exec "$C" curl -fs localhost:3090/api/health >/dev/null; then ok 'server healthy on the upgraded volume'; else bad 'server not healthy'; docker logs "$C" 2>&1 | tail -20; exit 1; fi

in_c() { docker exec "$C" "$@"; }
# The image sets HOME for appuser. The wrapper replaces it, and docker exec does not.
agent() { docker exec -u archon-agent -e HOME=/home/archon-agent "$C" sh -c "$1"; }
cli() { docker exec -u appuser -e HOME=/home/appuser -w /app "$C" bun --no-env-file /app/packages/cli/src/cli.ts "$@"; }

check 'appuser home is closed' "$(in_c stat -c %a /home/appuser)" 700
check 'home is traverse-only' "$(in_c stat -c '%a %G' /.archon)" '710 archon-work'
check 'source config is protected' "$(in_c stat -c '%a %G' $S/.git/config)" '644 appuser'
if agent 'cat /.archon/.env' 2>/dev/null; then bad 'agent read .env'; else ok 'agent cannot read .env'; fi
if agent 'ls /home/appuser' 2>/dev/null; then bad 'agent listed the appuser home'; else ok 'agent cannot list the appuser home'; fi
if agent "cd $OLD && echo y > a && git add a && git commit -qm old"; then ok 'agent commits in a worktree from before isolation'; else bad 'agent cannot commit in an old worktree'; fi

cli workflow run up --cwd "$S" --branch up-flow > /tmp/up.log 2>&1
run=$?
tail -12 /tmp/up.log
check 'workflow ran in a new worktree' "$run" 0
WT=$(in_c sh -c "find /.archon/workspaces/octocat/Hello-World/worktrees /.archon/worktrees -name uid -print 2>/dev/null | head -1 | xargs -r dirname")
if [ -n "$WT" ]; then
  check 'node ran as the agent' "$(in_c cat "$WT/uid")" 1201
  check 'node committed' "$(in_c cat "$WT/subject")" made-by-agent
else
  bad 'no worktree carries the node output'
fi

# Sessions and provisioning survive recreating the container.
in_c gosu archon-agent touch /home/archon-agent/.claude/marker
docker rm -f "$C" >/dev/null
docker run -d --name "$C" -e ARCHON_DOCKER=true -e ARCHON_AGENT_USER=archon-agent -e PORT=3090 \
  -v "$V:/.archon" -v "$V-agent:/home/archon-agent" "$IMAGE" >/dev/null
for _ in $(seq 60); do
  docker exec "$C" curl -fs localhost:3090/api/health >/dev/null 2>&1 && break
  sleep 2
done
if in_c test -f /home/archon-agent/.claude/marker; then ok 'agent home survives a recreate'; else bad 'agent home was lost'; fi
if [ -n "$WT" ] && agent "cd $WT && echo z > z && git add z && git commit -qm again"; then ok 'agent still commits after a restart'; else bad 'agent cannot commit after a restart'; fi

docker exec -u appuser -e HOME=/home/appuser -w "$S" "$C" bun --no-env-file /app/packages/cli/src/cli.ts complete up-flow --force > /tmp/up-done.log 2>&1
done=$?
tail -5 /tmp/up-done.log
check 'complete exits cleanly' "$done" 0
if grep -q '1 completed' /tmp/up-done.log; then ok 'complete removed the environment'; else bad 'complete removed nothing'; fi
if [ -z "$WT" ]; then bad 'no worktree to check for removal'; elif in_c test -e "$WT"; then bad 'worktree directory remains'; else ok 'worktree directory is gone'; fi
exit $rc
