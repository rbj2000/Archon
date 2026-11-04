#!/bin/bash
# Runs inside a disposable container from the built image, as root, with no volumes.
#   docker run --rm -i --entrypoint bash <image> -s < deploy/agent-exec/acceptance.sh
# acceptance.ts must already be at /tmp/acceptance.ts. Layout is built by hand until Phase 5.
set -u
R=/.archon/workspaces/o/r
WT=$R/worktrees/wt
mkdir -p "$WT" "$R/logs" "$R/state"
chown -R appuser:appuser /.archon
chgrp -R archon-work "$R/worktrees" "$R/state"
chmod 2775 "$R/state"
chmod -R g+rwX "$R/worktrees"
find "$R/worktrees" -type d -exec chmod g+s {} +
chmod 711 /.archon /.archon/workspaces /.archon/workspaces/o "$R"
chmod 700 "$R/logs" /home/appuser
chmod 644 /tmp/acceptance.ts

export DATABASE_URL="postgres://acceptance-sentinel" PGPASSWORD=acceptance-sentinel \
  ARCHON_SECRET=acceptance-sentinel ANTHROPIC_API_KEY=acceptance-sentinel \
  ARCHON_AGENT_USER=archon-agent HOME=/home/appuser
gosu appuser bun /tmp/acceptance.ts
rc=$?

echo '# no fallback when the wrapper is missing (A7)'
rm -f /usr/local/sbin/archon-agent-exec
cat >/tmp/fallback.ts <<'E'
import { runSubprocess } from '/app/packages/workflows/src/subprocess.ts';
const r = await runSubprocess({ kind: 'host' }, '/bin/bash', ['-c', 'id -u > /tmp/fallback-ran'], {
  cwd: '/.archon/workspaces/o/r/worktrees/wt', env: {}, retention: { standalone: true },
}).then(() => 'resolved', () => 'rejected');
console.log(r);
E
chmod 644 /tmp/fallback.ts
out=$(gosu appuser bun /tmp/fallback.ts 2>&1 | tail -1)
if [ "$out" = rejected ] && [ ! -e /tmp/fallback-ran ]; then
  echo 'ok   node fails and nothing ran'
else
  echo "FAIL fallback: $out"
  rc=1
fi
exit $rc
