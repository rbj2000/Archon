#!/bin/bash
# A1, A2, A3, A6 and A7 through the real entrypoint and CLI, on a Docker host, with real Claude and
# Pi. Costs a few small prompts. Needs HTTPS to github.com and CLAUDE_CODE_OAUTH_TOKEN in the
# environment. The sentinels stand in for the server's secrets.
# Usage: acceptance-nodes.sh <image> <path to Pi models.json> <Pi model>
set -u
IMAGE=$1
MODELS=$2
PI_MODEL=$3
V=archon-nodes-$$
C=archon-nodes-$$
SENTINEL=sentinel-$$-value
P=/.archon/workspaces/octocat/Hello-World
S=$P/source
rc=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; rc=1; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1: expected [$3], got [$2]"; fi; }
cleanup() { docker rm -f "$C" >/dev/null 2>&1; docker volume rm "$V" "$V-home" "$V-agent" >/dev/null 2>&1; }
trap cleanup EXIT

SEED=$(mktemp -d)
ENCODED=$(printf '%s' "$SENTINEL" | base64)
cat > "$SEED/probe.sh" <<'PROBE'
#!/bin/sh
# Prints one line per thing the boundary should have refused, then DONE. The sentinel arrives
# encoded and is matched from a file, so no process's arguments carry it and ps cannot match itself.
out="probe-$1.txt"
pattern=$(mktemp)
echo "$2" | base64 -d > "$pattern"
{
  echo "uid=$(id -u)"
  env | grep -qf "$pattern" && echo "LEAK sentinel in environment"
  for f in /proc/1/environ /.archon/.env /.archon/archon.db /home/appuser/.gitconfig; do
    cat "$f" >/dev/null 2>&1 && echo "READ $f"
  done
  for d in /.archon /home/appuser "$3/logs" "$3/source"; do
    ls "$d" >/dev/null 2>&1 && echo "READ listing $d"
  done
  for pid in $(ps -u appuser -o pid= 2>/dev/null); do
    cat "/proc/$pid/environ" >/dev/null 2>&1 && echo "READ server environ $pid"
  done
  ps -eww e 2>/dev/null | grep -qf "$pattern" && echo "LEAK sentinel through ps"
  for d in /.archon /.archon/workflow-source /.archon/workspaces /home/appuser /app "$3/source/.git" "$3/source/.git/hooks"; do
    if touch "$d/.probe-$1" 2>/dev/null; then echo "WROTE $d"; fi
    if ln -s /etc/passwd "$d/.link-$1" 2>/dev/null; then echo "LINKED $d"; fi
  done
  (echo x >> /app/package.json) 2>/dev/null && echo "WROTE /app/package.json"
  (echo x >> "$3/source/.git/config") 2>/dev/null && echo "WROTE source config"
  echo DONE
} > "$out" 2>&1
PROBE
cat > "$SEED/sleep.sh" <<'SLEEP'
#!/bin/sh
sleep 1000 &
setsid sleep 1000 &
nohup sleep 1000 >/dev/null 2>&1 &
sleep 1000
SLEEP
cat > "$SEED/nodes.yaml" <<YAML
name: nodes
description: every node type
nodes:
  - id: sh
    bash: sh $P/artifacts/probe.sh bash $ENCODED $P
  - id: js
    depends_on: [sh]
    runtime: bun
    script: |
      import { execFileSync } from 'node:child_process';
      execFileSync('sh', ['$P/artifacts/probe.sh', 'script', '$ENCODED', '$P']);
  - id: claude
    depends_on: [js]
    provider: claude
    model: haiku
    prompt: 'Use the Bash tool to run exactly this command, then reply done: sh $P/artifacts/probe.sh claude $ENCODED $P'
  - id: pi
    depends_on: [claude]
    provider: pi
    model: $PI_MODEL
    prompt: 'Use the bash tool to run exactly this command, then reply done: sh $P/artifacts/probe.sh pi $ENCODED $P'
YAML
cat > "$SEED/sleeper.yaml" <<YAML
name: sleeper
description: a tree that must be ended
nodes:
  - id: s
    bash: sh $P/artifacts/sleep.sh
YAML
cat > "$SEED/a7.yaml" <<'YAML'
name: a7
description: no wrapper means no run
nodes:
  - id: s
    bash: id -u > a7-uid
YAML
cp "$MODELS" "$SEED/models.json"
chmod -R a+rX "$SEED"
docker run --rm --entrypoint bash -v "$V:/.archon" -v "$V-home:/home/appuser" -v "$SEED:/seed:ro" "$IMAGE" -c "
  set -e
  mkdir -p $(dirname $S)
  git clone -q https://github.com/octocat/Hello-World.git $S
  # Global, because the workspace sync resets the source checkout to its remote.
  mkdir -p /.archon/workflows /home/appuser/.pi/agent
  cp /seed/*.yaml /.archon/workflows/
  # Worktrees branch from the remote, so a shared directory is what reaches every node.
  mkdir -p $P/artifacts
  cp /seed/probe.sh /seed/sleep.sh $P/artifacts/
  cp /seed/models.json /home/appuser/.pi/agent/models.json
  echo $SENTINEL > /.archon/.env
  chown -R appuser:appuser /.archon /home/appuser
" || { bad 'seeding failed'; exit 1; }
rm -rf "$SEED"

docker run -d --init --name "$C" -e ARCHON_DOCKER=true -e ARCHON_AGENT_USER=archon-agent -e PORT=3090 \
  -e PGPASSWORD="$SENTINEL" -e ARCHON_SECRET="$SENTINEL" -e CLAUDE_CODE_OAUTH_TOKEN \
  -v "$V:/.archon" -v "$V-home:/home/appuser" -v "$V-agent:/home/archon-agent" "$IMAGE" >/dev/null
for _ in $(seq 60); do
  docker exec "$C" curl -fs localhost:3090/api/health >/dev/null 2>&1 && break
  sleep 2
done
in_c() { docker exec "$C" "$@"; }
cli() { docker exec -u appuser -e HOME=/home/appuser -w "$S" "$C" bun --no-env-file /app/packages/cli/src/cli.ts "$@"; }
# A zombie is already dead. It stays listed only because nothing has reaped it.
count_agent() { in_c sh -c 'ps -u 1201 -o stat= | grep -vc "^Z"' | tr -d ' '; }
wait_gone() {
  for _ in $(seq "$1"); do [ "$(count_agent)" = 0 ] && return 0; sleep 1; done
  return 1
}

cli workflow run nodes --cwd "$S" --branch nodes-run > /tmp/nodes.log 2>&1
check 'nodes workflow completes' "$?" 0
grep -E 'Failed|failed' /tmp/nodes.log | cut -c1-200 | grep -v "$SENTINEL" | head -5
WT=$(in_c sh -c "dirname \$(find $P/worktrees -name probe-bash.txt | head -1)")
for who in bash script claude pi; do
  out=$(in_c cat "$WT/probe-$who.txt" 2>/dev/null)
  check "A1 $who runs as the agent" "$(echo "$out" | grep '^uid=')" uid=1201
  check "A1-A3 $who probe finished" "$(echo "$out" | tail -1)" DONE
  found=$(echo "$out" | grep -E '^(LEAK|READ|WROTE|LINKED)')
  if [ -z "$out" ]; then bad "$who left no probe output"; elif [ -z "$found" ]; then ok "A1-A3 $who was refused everything"; else bad "$who got through: $(echo "$found" | tr '\n' ';')"; fi
done
if grep -q "$SENTINEL" /tmp/nodes.log; then bad 'sentinel reached workflow output'; else ok 'sentinel absent from workflow output'; fi
check 'source config survived the probes' "$(in_c stat -c '%a %U' $S/.git/config)" '644 appuser'

# A6: cancel, then SIGKILL of the owner, each with a session-escaped child.
start_sleeper() {
  docker exec -d -u appuser -e HOME=/home/appuser -w "$S" "$C" bun --no-env-file /app/packages/cli/src/cli.ts workflow run sleeper --cwd "$S" --branch "$1" ${2:-}
  for _ in $(seq 40); do [ "$(in_c sh -c 'ps -u 1201 -o comm= | grep -c "^sleep"')" -ge 4 ] && return 0; sleep 1; done
  return 1
}
if start_sleeper a6-cancel --detach; then
  cli workflow status --json > /tmp/a6-status.log 2>&1
  id=$(grep -m1 '"id":' /tmp/a6-status.log | grep -oE '[0-9a-f]{32}')
  echo "cancelling run [$id]"
  cli workflow cancel "$id" > /tmp/a6-cancel.log 2>&1
  cancelled=$?
  grep -v '"level":' /tmp/a6-cancel.log | tail -3 | cut -c1-300
  check 'A6 cancel reports success' "$cancelled" 0
  [ "$cancelled" = 0 ] || in_c ps -eo pid,ppid,pgid,uid,stat,comm
  if cli workflow status --json 2>/dev/null | grep -q "\"id\": \"$id\""; then bad 'A6 the run still reads as running'; else ok 'A6 the run left the running list'; fi
  if wait_gone 15; then ok 'A6 cancel ends the tree, including setsid and nohup'; else bad "A6 survivors after cancel: $(in_c ps -u 1201 -o args= | tr '\n' ';')"; fi
else
  bad 'A6 sleeper did not start'
fi
in_c sh -c 'ps -u 1201 -o pid= | xargs -r kill -9' 2>/dev/null
if start_sleeper a6-kill; then
  owner=$(in_c sh -c "ps -u appuser -o pid=,args= | grep 'workflow run sleeper' | grep -v grep | awk '{print \$1}' | head -1")
  in_c kill -9 "$owner"
  if wait_gone 15; then ok 'A6 SIGKILL of the owner ends the tree'; else bad "A6 survivors after SIGKILL: $(in_c ps -u 1201 -o args= | tr '\n' ';')"; fi
else
  bad 'A6 second sleeper did not start'
fi

# A7: last, because it removes the wrapper.
in_c rm /usr/local/sbin/archon-agent-exec
cli workflow run a7 --cwd "$S" --branch a7-run > /tmp/a7.log 2>&1
a7=$?
if [ "$a7" != 0 ] && grep -qE 'archon-agent-exec|sudo' /tmp/a7.log; then ok 'A7 the run fails because the wrapper is gone'; else bad "A7 failed for another reason or not at all: $(tail -3 /tmp/a7.log | cut -c1-200)"; fi
check 'A7 nothing ran as the server' "$(in_c sh -c "find $P/worktrees -name a7-uid | wc -l" | tr -d ' ')" 0
exit $rc
