#!/bin/bash
# Tests archon-agent-exec with real uids and real sudo. Runs in the agent-exec-test image stage;
# scripts/test-agent-exec.sh builds and starts it. It needs root only for the setup below.
set -u
W=/usr/local/sbin/archon-agent-exec
R=/.archon/workspaces/o/r
WT=$R/worktrees/wt

if [ "${1:-}" != --run ]; then
  mkdir -p "$WT/deep" "$R/artifacts/runs/1" /.archon/worktrees/legacy "$R/logs" /tmp/t \
    /.archon/workspaces/o/r/worktrees/real
  ln -s "$WT" "$R/worktrees/link"
  ln -s /tmp/t /.archon/worktrees/escape
  ln -s "$R/worktrees" "$R/linkroot"
  chown -R archon-agent /.archon
  chmod 1777 /tmp/t
  exec gosu appuser bash "$0" --run
fi

pass=0
failed=0
ok() { pass=$((pass + 1)); }
no() { failed=$((failed + 1)); echo "FAIL: $*"; }
eq() { if [ "$2" = "$3" ]; then ok; else no "$1: expected [$3], got [$2]"; fi; }
has() { case "$2" in *"$3"*) ok ;; *) no "$1: [$2] lacks [$3]" ;; esac; }
hasnt() { case "$2" in *"$3"*) no "$1: [$2] contains [$3]" ;; *) ok ;; esac; }

ENV_IN=$(mktemp)
: >"$ENV_IN"
setenv_block() { if [ $# -eq 0 ]; then : >"$ENV_IN"; else printf '%s\0' "$@" >"$ENV_IN"; fi; }
# Runs the wrapper as the server will. The control pipe stays open for 60 s.
w() { sudo -n -C 5 -u archon-agent "$W" "$@" 3<"$ENV_IN" 4< <(sleep 60 2>/dev/null) 2>&1; }
agents() { pgrep -u 1201 -c "${1:-.}" 2>/dev/null || true; }
clean() { sudo -n -C 5 -u archon-agent "$W" --home -- sh -c 'pkill -KILL -x sleep; pkill -KILL -x trap-term; true' 3</dev/null 4< <(sleep 2) >/dev/null 2>&1; }
wait_gone() { # seconds, pattern
  local i
  for i in $(seq $(($1 * 10))); do
    [ "$(pgrep -u 1201 -c -f "$2" 2>/dev/null)" = 0 ] && return 0
    sleep 0.1
  done
  return 1
}

echo '# refused environment keys'
for key in DATABASE_URL PGHOST PGPASSWORD ARCHON_SECRET ARCHON_ LD_PRELOAD LD_LIBRARY_PATH BASH_ENV ENV \
  GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_CONFIG GIT_CONFIG_GLOBAL GIT_CONFIG_NOSYSTEM GIT_EXEC_PATH \
  NODE_OPTIONS BUN_OPTIONS; do
  setenv_block "$key=sentinel-value"
  out=$(w --home -- /usr/bin/id -u)
  rc=$?
  eq "$key exit" "$rc" 125
  has "$key message" "$out" "$key"
  hasnt "$key value" "$out" sentinel-value
done

echo '# allowed keys'
setenv_block ARCHON_RUN_ENV_KEYS=a ARCHON_NODE_EXECUTION=b ARCHON_CLI_COMMAND=c GIT_AUTHOR_NAME=d \
  GIT_TERMINAL_PROMPT=0 'WEIRD=line1
line2=x' UNICODE=čšž EMPTY= archon_lower=e pgsql=f
out=$(w --home -- /usr/bin/env)
eq 'allowed exit' $? 0
for want in ARCHON_RUN_ENV_KEYS=a ARCHON_NODE_EXECUTION=b ARCHON_CLI_COMMAND=c GIT_AUTHOR_NAME=d \
  GIT_TERMINAL_PROMPT=0 $'WEIRD=line1\nline2=x' UNICODE=čšž EMPTY= archon_lower=e pgsql=f; do
  has 'allowed passes' "$out" "$want"
done
setenv_block ARCHON_RUN_ENV_KEYSX=a
w --home -- /usr/bin/id >/dev/null
eq 'allowlist lookalike' $? 125

echo '# malformed environment'
malformed() { # name, printf format
  printf "$2" >"$ENV_IN"
  w --home -- /usr/bin/id >/dev/null
  eq "$1" $? 125
}
malformed truncated 'A=1\0B=2'
malformed 'no equals' 'NOEQUALS\0'
malformed 'empty key' '=x\0'
malformed 'empty record' '\0'
malformed 'digit key' '1A=x\0'
malformed 'bad key char' 'A-B=x\0'
malformed duplicate 'A=1\0A=2\0'
head -c 1048577 /dev/zero | tr '\0' a >"$ENV_IN"
w --home -- /usr/bin/id >/dev/null
eq oversized $? 125
setenv_block
out=$(w --home -- /usr/bin/id -u)
eq 'empty block' "$?:$out" 0:1201
sudo -n -C 5 -u archon-agent "$W" --home -- /usr/bin/id 3<"$ENV_IN" >/dev/null 2>&1
eq 'no control fd' $? 125
sudo -n -C 5 -u archon-agent "$W" --home -- /usr/bin/id 4</dev/null >/dev/null 2>&1
eq 'no env fd' $? 125
"$W" --home -- /usr/bin/id 3<"$ENV_IN" 4</dev/null >/dev/null 2>&1
eq 'direct run as appuser' $? 125

echo '# arguments'
for args in '--home' '--home --' '--home /usr/bin/id' '--cwd --' '--bogus -- /usr/bin/id' "--cwd $WT /usr/bin/id" '--'; do
  # shellcheck disable=SC2086
  w $args >/dev/null
  eq "args [$args]" $? 125
done

echo '# working directory'
for dir in "$WT" "$WT/deep" "$R/artifacts/runs/1" /.archon/worktrees/legacy; do
  out=$(w --cwd "$dir" -- /bin/pwd -P)
  eq "cwd $dir" "$?:$out" "0:$dir"
done
for dir in / /tmp /.archon /.archon/worktrees /.archon/workspaces/o/r "$R/worktrees" "$R/artifacts" \
  "$R/logs" "$R/source" /home/appuser /app "$WT/../.." "$WT/." "$WT/" "//.archon/worktrees/legacy" \
  "$R/worktrees/link" "$R/worktrees/link/deep" /.archon/worktrees/escape "$R/linkroot/wt" \
  "$WT/missing" "$WT/../wt" relative/path ""; do
  w --cwd "$dir" -- /bin/pwd >/dev/null
  eq "cwd refused [$dir]" $? 125
done
touch "$WT/file" 2>/dev/null
w --cwd "$WT/file" -- /bin/pwd >/dev/null
[ -e "$WT/file" ] && eq 'cwd file' $? 125

echo '# fixed values and inherited state'
setenv_block HOME=/tmp/x USER=root LOGNAME=root PATH=/tmp/x
out=$(HOME=/tmp/y FOO_FROM_CALLER=1 w --home -- /usr/bin/env)
has 'HOME' "$out" HOME=/home/archon-agent
has 'USER' "$out" USER=archon-agent
has 'LOGNAME' "$out" LOGNAME=archon-agent
has 'PATH' "$out" PATH=/usr/local/bin:/usr/bin:/bin
hasnt 'caller env' "$out" FOO_FROM_CALLER
hasnt 'sudo env' "$out" SUDO_
eq 'env is exact' "$(printf '%s\n' "$out" | wc -l)" 4
setenv_block
eq 'uid' "$(w --home -- /usr/bin/id -u)" 1201
eq 'umask' "$(w --home -- sh -c umask)" 0002
has 'groups' "$(w --home -- /usr/bin/id -nG)" archon-work
eq 'cwd for --home' "$(w --home -- /bin/pwd)" /home/archon-agent
eq 'only stdio open' "$(w --home -- sh -c 'cd /proc/self/fd && ls -1 | sort -n | tr "\n" " "')" '0 1 2 '
eq 'new session' "$(w --home -- sh -c 'ps -o pid=,sid= -p $$ | awk "{print (\$1==\$2)}"')" 1

echo '# stdio and exit status'
eq 'stdin round trip' "$(echo rpc | sudo -n -C 5 -u archon-agent "$W" --home -- /bin/cat 3<"$ENV_IN" 4< <(sleep 5 2>/dev/null))" rpc
w --home -- sh -c 'exit 42' >/dev/null
eq 'exit status' $? 42
w --home -- sh -c 'kill -KILL $$' >/dev/null
eq 'signal status' $? 137
out=$(w --home -- /nonexistent/program)
eq 'exec failure' $? 127
has 'exec message' "$out" /nonexistent/program
w --home -- sh -c 'exit 125' >/dev/null
eq 'program can exit 125' $? 125

echo '# sudo rule'
sudo -n -u archon-agent /usr/bin/id >/dev/null 2>&1
eq 'other command refused' $? 1
sudo -n -u root "$W" --home -- /usr/bin/id </dev/null >/dev/null 2>&1
eq 'other target refused' $? 1
sudo -n DATABASE_URL=x -C 5 -u archon-agent "$W" --home -- /usr/bin/id 3<"$ENV_IN" 4</dev/null >/dev/null 2>&1
eq 'setenv refused' $? 1
DATABASE_URL=leak out=$(w --home -- /usr/bin/env)
hasnt 'caller secret' "$out" DATABASE_URL
sudo -n -E -C 5 -u archon-agent "$W" --home -- /usr/bin/id 3<"$ENV_IN" 4</dev/null >/dev/null 2>&1
eq '-E refused' $? 1
has 'agent has no sudo' "$(w --home -- sudo -n true)" 'sudo'

echo '# termination'
# Starts a tree under sudo with a controllable pipe. Sets SUDO_PID and CTL_PID.
start_tree() { # marker, shell body
  local fifo
  fifo=$(mktemp -u)
  mkfifo "$fifo"
  sleep 300 >"$fifo" &
  CTL_PID=$!
  # `&` starts a job with SIGINT ignored, which sudo would inherit; the server's spawn does not.
  env --default-signal=INT setsid sudo -n -C 5 -u archon-agent "$W" --home -- bash -c "$2" "$1" 3<"$ENV_IN" 4<"$fifo" </dev/null >/dev/null 2>&1 &
  SUDO_PID=$!
  rm -f "$fifo"
  local i
  for i in $(seq 50); do
    [ "$(pgrep -u 1201 -c -f "sleep 1000")" != 0 ] && return 0
    sleep 0.1
  done
  no "tree $1 did not start"
}
TREE='sleep 1000 & wait'
for sig in TERM INT HUP; do
  # exec: background jobs of a non-interactive shell ignore SIGINT, so `&` would not test delivery.
  start_tree "sig$sig" 'exec sleep 1000'
  kill -"$sig" "$SUDO_PID"
  wait_gone 3 'sleep 1000' && ok || no "SIG$sig left the tree alive"
  kill "$CTL_PID" 2>/dev/null
  clean
done

start_tree eof "$TREE"
kill "$CTL_PID"
wait_gone 3 'sleep 1000' && ok || no 'control pipe EOF left the tree alive'
clean

start_tree sudokill "$TREE"
kill -KILL "$SUDO_PID"
wait_gone 3 'sleep 1000' && ok || no 'SIGKILL of sudo left the tree alive'
kill "$CTL_PID" 2>/dev/null
clean

start_tree background 'sleep 1000 & sleep 1; exit 0'
wait_gone 3 'sleep 1000' && ok || no 'background process survived the leader'
kill "$CTL_PID" 2>/dev/null
clean

start_tree escaped 'setsid sleep 1000 & nohup setsid sh -c "sleep 1000" & wait'
kill -TERM "$SUDO_PID"
wait_gone 3 'sleep 1000' && ok || no 'escaped session survived'
kill "$CTL_PID" 2>/dev/null
clean

start_tree doublefork '(setsid sh -c "sleep 1000 & exit 0" &) ; sleep 1000 & wait'
kill -TERM "$SUDO_PID"
wait_gone 3 'sleep 1000' && ok || no 'double fork survived'
kill "$CTL_PID" 2>/dev/null
clean

start_tree stubborn 'trap "" TERM INT HUP; sleep 1000 & while :; do sleep 0.2; done'
started=$(date +%s)
kill -TERM "$SUDO_PID"
sleep 5
[ "$(pgrep -u 1201 -c -f 'while :')" != 0 ] && ok || no 'ended before the grace period'
wait_gone 8 'while :' && ok || no 'TERM-ignoring tree survived SIGKILL'
took=$(($(date +%s) - started))
[ "$took" -ge 9 ] && [ "$took" -le 13 ] && ok || no "grace period took ${took}s"
kill "$CTL_PID" 2>/dev/null
clean

echo '# concurrent runs'
start_tree one 'sleep 1000 & wait'
a_sudo=$SUDO_PID a_ctl=$CTL_PID
fifo=$(mktemp -u)
mkfifo "$fifo"
sleep 300 >"$fifo" &
b_ctl=$!
setsid sudo -n -C 5 -u archon-agent "$W" --home -- bash -c 'sleep 2000 & wait' 3<"$ENV_IN" 4<"$fifo" </dev/null >/dev/null 2>&1 &
rm -f "$fifo"
sleep 1
kill -TERM "$a_sudo"
wait_gone 3 'sleep 1000' && ok || no 'first run survived'
[ "$(pgrep -u 1201 -c -f 'sleep 2000')" != 0 ] && ok || no 'cancelling one run ended the other'
kill "$b_ctl" "$a_ctl" 2>/dev/null
wait_gone 3 'sleep 2000' && ok || no 'second run survived its own EOF'

echo "passed=$pass failed=$failed"
[ "$failed" = 0 ]
