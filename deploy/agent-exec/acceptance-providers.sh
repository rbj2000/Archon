#!/bin/bash
# Real workflows through the real CLI and executor, with real Claude and Pi, as archon-agent.
# Runs as root in a disposable container with network access, the Claude credential in its
# environment and Pi's models.json at /home/appuser/.pi/agent/. Costs a few small prompts.
# The directory layout is built by hand until the entrypoint owns it.
set -u
R=/.archon/workspaces/o/r
WT=$R/worktrees/wt
CLI="bun --no-env-file /app/packages/cli/src/cli.ts"
rc=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: expected [$3], got [$2]"; rc=1; fi; }

mkdir -p "$WT" /.archon/.archon/workflows
chown -R appuser:archon-work /.archon /home/appuser
chmod 755 /home/appuser/.pi /home/appuser/.pi/agent 2>/dev/null
find /.archon -type d -exec chmod 2775 {} +
chmod 700 /home/appuser
# The same provisioning as docker-entrypoint.sh.
install -d -o archon-agent -g archon-agent -m 700 \
  /home/archon-agent/.claude /home/archon-agent/.pi /home/archon-agent/.pi/agent
install -o root -g archon-agent -m 640 /home/appuser/.pi/agent/models.json \
  /home/archon-agent/.pi/agent/models.json

printf 'store: files\ndefaultAssistant: claude\n' > /.archon/config.yaml
W=$WT/.archon/workflows
mkdir -p "$W"
cat > "$W/smoke.yaml" <<YAML
name: smoke
description: isolation smoke
nodes:
  - id: sh
    bash: |
      id -u > sh-uid
      printenv CLAUDE_CODE_OAUTH_TOKEN > sh-token || true
      printf '"from-bash"' | $CLI state put smoke-doc --if-revision 0
  - id: py
    depends_on: [sh]
    script: |
      import { writeFileSync } from 'node:fs';
      writeFileSync('script-uid', String(process.getuid()));
    runtime: bun
  - id: claude
    depends_on: [py]
    provider: claude
    model: haiku
    prompt: 'Use the Bash tool to run exactly: id -u > claude-uid. Then reply done.'
  - id: pi
    depends_on: [claude]
    provider: pi
    model: vllm39/qwen3.8-27b
    prompt: 'Use the bash tool to run exactly: id -u > pi-uid. Then reply done.'
YAML
cat > "$W/conflict.yaml" <<YAML
name: conflict
description: a refused queued write fails the node
nodes:
  - id: stale
    bash: printf '"x"' | $CLI state put conflict-doc --if-revision 99
YAML
chown -R appuser:archon-work "$WT"
chmod -R g+rwX "$WT"

as_server() {
  gosu appuser env HOME=/home/appuser ARCHON_AGENT_USER=archon-agent ARCHON_HOME=/.archon \
    PGPASSWORD=acceptance-sentinel ARCHON_SECRET=acceptance-sentinel "$@"
}
cd "$WT" || exit 1
umask 002
as_server $CLI workflow run smoke --cwd "$WT" --folder --no-worktree > /tmp/smoke.log 2>&1
smoke=$?
tail -25 /tmp/smoke.log
check 'smoke workflow completes' "$smoke" 0
for who in sh script claude pi; do
  check "$who ran as archon-agent" "$(cat "$WT/$who-uid" 2>/dev/null)" 1201
done
check 'bash node has no Claude token' "$(cat "$WT/sh-token" 2>/dev/null)" ''
as_server $CLI state get smoke-doc --cwd "$WT" > /tmp/doc.json 2>&1
check 'queued write landed' "$(grep -c from-bash /tmp/doc.json)" 1

as_server $CLI workflow run conflict --cwd "$WT" --folder --no-worktree > /tmp/conflict.log 2>&1
conflict=$?
tail -8 /tmp/conflict.log
if [ "$conflict" != 0 ]; then echo 'ok   stale queued write fails the run'; else echo 'FAIL stale write passed'; rc=1; fi
as_server $CLI workflow run smoke --help >/dev/null 2>&1
check 'no agent process left behind' "$(pgrep -u 1201 -c . || true)" 0
exit $rc
