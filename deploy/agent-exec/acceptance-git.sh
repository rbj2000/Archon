#!/bin/bash
# The Phase 0 attack against the real entrypoint layout and real git routing. Runs as root in a
# disposable container. The pass condition is that no payload ever records uid 1001.
set -u
R=/.archon/workspaces/o/r
S=$R/source
WT=$R/worktrees/wt
A=$R/worktrees/attack
M=/tmp/markers
rc=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; rc=1; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1: expected [$3], got [$2]"; fi; }
denied() { if gosu archon-agent sh -c "$2" 2>/dev/null; then bad "agent could: $1"; else ok "agent cannot: $1"; fi; }

mkdir -p "$M" /.archon/worktrees "$R/artifacts" "$R/logs" "$R/state"
chmod 1777 "$M"
echo secret > /.archon/.env
echo cfg > /.archon/config.yaml
echo log > "$R/logs/t.log"
git init -q -b main "$S"
git -C "$S" config user.email a@a
git -C "$S" config user.name a
echo one > "$S/f"
git -C "$S" add f
git -C "$S" commit -qm init
chown -R appuser:appuser /.archon
chown -R appuser:appuser /home/appuser

layout() {
  gosu appuser bun -e 'import { applyAgentLayout } from "@archon/git"; await applyAgentLayout("/.archon");'
}
as_server() {
  gosu appuser env HOME=/home/appuser ARCHON_AGENT_USER=archon-agent ARCHON_HOME=/.archon "$@"
}
# Real files, because `bun -e` would take git's -C for its own. They live in /app to resolve imports.
cat > /app/.gitx.ts <<'TS'
import { execFileAsync } from '@archon/git';
const r = await execFileAsync('git', process.argv.slice(2), { maxBuffer: 1 << 24 });
process.stdout.write(r.stdout);
TS
cat > /app/.share.ts <<'TS'
import { execFileAsync, shareTree } from '@archon/git';
const path = process.argv[2];
await shareTree(path);
const r = await execFileAsync('git', ['-C', path, 'rev-parse', '--absolute-git-dir']);
await shareTree(r.stdout.trim());
TS
chmod 644 /app/.gitx.ts /app/.share.ts
cd /app || exit 1
gitx() { as_server bun /app/.gitx.ts "$@"; }
share() { as_server bun /app/.share.ts "$1"; }
layout || bad 'layout failed'
printf '[safe]\n\tdirectory = *\n[user]\n\tname = a\n\temail = a@a\n' > /home/archon-agent/.gitconfig
chown root:archon-agent /home/archon-agent/.gitconfig
chmod 640 /home/archon-agent/.gitconfig

check 'home is traverse-only' "$(stat -c '%a %G' /.archon)" '710 archon-work'
check '.git is not group-writable' "$(stat -c '%a' "$S/.git")" 755
check 'config is not group-writable' "$(stat -c '%a %U' "$S/.git/config")" '644 appuser'
check 'objects are shared' "$(stat -c '%G' "$S/.git/objects")" archon-work
for wt in "$WT" "$A"; do
  gitx -C "$S" worktree add -q -b "b-$(basename "$wt")" "$wt" || bad "worktree add $wt"
  share "$wt" || bad "share $wt"
done

# What the agent must keep working.
if gosu archon-agent sh -c "cd $WT && umask 002 && echo two >> f && git add f && git commit -qm agent"; then
  ok 'agent commits in its worktree'
else
  bad 'agent commit failed'
fi
check 'server sees the agent commit' "$(gitx -C "$WT" log -1 --format=%s)" agent

# The server rewriting config must not open it to the shared group.
gitx -C "$S" config archon.test 1
check 'config stays out of the shared group' "$(stat -c '%G' "$S/.git/config")" appuser

# Reads and writes the boundary must refuse.
denied 'read .env' 'cat /.archon/.env'
denied 'read config.yaml' 'cat /.archon/config.yaml'
denied 'read logs' "cat $R/logs/t.log"
denied 'list the home' 'ls /.archon'
denied 'write source config' "echo x >> $S/.git/config"
denied 'replace source config' "mv $S/.git/config $S/.git/config2"
denied 'remove source config' "rm $S/.git/config"
denied 'plant a hook' "echo x > $S/.git/hooks/post-checkout"
denied 'plant commondir' "echo /tmp > $S/.git/commondir"
denied 'plant config.worktree' "echo x > $S/.git/config.worktree"

# The attack: redirect the attack worktree at a repository whose config runs a payload.
P=/tmp/evil
gosu archon-agent sh -c "
  set -e
  git init -q -b main $P
  cd $P
  git config user.email a@a; git config user.name a
  echo 'f filter=evil' > .gitattributes
  echo content > f
  git add .; git commit -qm evil
  # Scripts, because a semicolon would start a comment in a git config value.
  printf '#!/bin/sh\nid -u >> $M/filter\ncat\n' > $P/clean
  printf '#!/bin/sh\nid -u >> $M/textconv\ncat \"\$1\"\n' > $P/textconv
  printf '#!/bin/sh\nid -u >> $M/fsmonitor\n' > $P/fsmonitor
  chmod +x $P/clean $P/textconv $P/fsmonitor
  cat >> .git/config <<CFG
[filter \"evil\"]
	clean = $P/clean
	required = true
[core]
	fsmonitor = $P/fsmonitor
	hooksPath = $P/hooks
[diff \"evil\"]
	textconv = $P/textconv
CFG
  mkdir -p $P/hooks
  printf '#!/bin/sh\nid -u >> $M/hook\n' > $P/hooks/post-checkout
  chmod +x $P/hooks/post-checkout
"
ADMIN=$(gitx -C "$A" rev-parse --absolute-git-dir)
gosu archon-agent sh -c "
  echo changed >> $A/f
  echo 'f filter=evil diff=evil' > $A/.gitattributes
  printf '%s\n' $P/.git > $ADMIN/commondir
"
for args in 'status --porcelain' 'add -A' 'diff' 'rev-parse HEAD'; do
  # shellcheck disable=SC2086
  gitx -C "$A" $args >/dev/null 2>&1
done
as_server bun -e 'import { observeCheckout } from "@archon/workflows/checkout-observation"; console.log(typeof observeCheckout)' >/dev/null 2>&1
gitx -C "$S" worktree list >/dev/null 2>&1
gitx -C "$S" worktree remove "$A" >/dev/null 2>&1
gitx -C "$S" worktree prune >/dev/null 2>&1

# The same with .git replaced by a gitfile into the planted repository.
gosu archon-agent sh -c "printf 'gitdir: $P/.git\n' > $WT/.git; echo changed >> $WT/f; echo 'f filter=evil diff=evil' > $WT/.gitattributes" 2>/dev/null
gitx -C "$WT" status --porcelain >/dev/null 2>&1
gitx -C "$WT" add -A >/dev/null 2>&1

fired=0
for marker in "$M"/*; do
  [ -e "$marker" ] || continue
  fired=1
  if grep -qx 1001 "$marker"; then bad "payload ran as the server: $marker"; else ok "payload only reached uid 1201: $marker"; fi
done
# Silence would prove nothing: the redirect has to have reached a payload.
[ "$fired" = 1 ] || bad 'no payload fired, so the attack was not exercised'

# The layout survives agent files it cannot change, and a repeat.
gosu archon-agent sh -c "mkdir -p $S/.git/objects/zz && touch $S/.git/objects/zz/planted && chmod 700 $S/.git/objects/zz"
if layout; then ok 'a planted agent file does not stop the layout'; else bad 'planted file broke the layout'; fi

# A planted symlink does not lead the layout to the secret.
gosu archon-agent ln -s /.archon/.env "$R/artifacts/link"
before=$(stat -c '%a %G' /.archon/.env)
layout
check 'the layout does not follow a symlink' "$(stat -c '%a %G' /.archon/.env)" "$before"

# A clean worktree the agent locked up can still be removed, and a dirty one is refused.
gitx -C "$S" worktree add -q -b b-clean "$R/worktrees/clean" >/dev/null
share "$R/worktrees/clean" || bad 'share clean'
[ -d "$R/worktrees/clean" ] || bad 'clean worktree was not created'
gosu archon-agent sh -c "echo dirty > $R/worktrees/clean/new"
gitx -C "$S" worktree remove "$R/worktrees/clean" >/dev/null 2>&1
if [ -d "$R/worktrees/clean" ]; then ok 'dirty worktree is refused'; else bad 'dirty worktree was removed'; fi
gosu archon-agent sh -c "rm $R/worktrees/clean/new; mkdir $R/worktrees/clean/shut; touch $R/worktrees/clean/shut/f; chmod 700 $R/worktrees/clean/shut; printf 'shut\n' >> $R/worktrees/clean/.git/info/exclude" 2>/dev/null
gitx -C "$S" worktree remove --force "$R/worktrees/clean" >/dev/null 2>&1
if [ -e "$R/worktrees/clean" ]; then bad 'agent-closed directory blocked removal'; else ok 'agent-closed directory does not block removal'; fi
exit $rc
