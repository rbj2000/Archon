/*
 * archon-agent-exec: the only way into the archon-agent user.
 *
 *   sudo -n -C 5 -u archon-agent archon-agent-exec (--cwd <dir> | --home) -- <program> [args...]
 *
 * fd 3: environment for the program, NUL-terminated KEY=VALUE records, up to EOF.
 * fd 4: control pipe. The caller holds the write end; EOF ends the program's tree.
 *
 * Exit status: the program's, or 128+signal. 125 is a refusal by this wrapper; 127 a failed exec.
 *
 * It stays alive as a supervisor because the caller's uid cannot signal the tree. It cannot defend
 * against the program itself, which has the same uid and could kill it.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/signalfd.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define AGENT_UID 1201
#define AGENT_HOME "/home/archon-agent"
#define AGENT_USER "archon-agent"
#define AGENT_PATH "/usr/local/bin:/usr/bin:/bin"
#define EXIT_REFUSED 125
#define EXIT_EXEC_FAILED 127
#define EXIT_GRACE_MS 10000
#define KILL_RETRY_MS 100
#define ENV_FD 3
#define CONTROL_FD 4
#define MAX_ENV_BYTES (1024 * 1024)
#define MAX_ENV_RECORDS 4096
#define MAX_CWD_DEPTH 64

extern char **environ;

/* The ARCHON_* keys a node legitimately receives; see buildExecNodeEnvironment and
 * buildAiNodeEnvironment in packages/workflows/src/exec-environment.ts. */
static const char *const ALLOWED_ARCHON[] = {
    "ARCHON_RUN_ENV_KEYS",
    "ARCHON_NODE_EXECUTION",
    "ARCHON_CLI_COMMAND",
};

static const char *const DENIED_EXACT[] = {
    "DATABASE_URL", "BASH_ENV",        "ENV",           "NODE_OPTIONS",
    "GIT_DIR",      "GIT_WORK_TREE",   "GIT_COMMON_DIR", "GIT_EXEC_PATH",
};

static const char *const DENIED_PREFIX[] = {"PG", "ARCHON_", "LD_", "BUN_", "GIT_CONFIG"};

#define COUNT(a) (sizeof(a) / sizeof((a)[0]))

__attribute__((noreturn, format(printf, 1, 2))) static void refuse(const char *format, ...) {
  va_list args;
  va_start(args, format);
  fputs("archon-agent-exec: ", stderr);
  vfprintf(stderr, format, args);
  fputc('\n', stderr);
  va_end(args);
  _exit(EXIT_REFUSED);
}

static bool valid_key(const char *key, size_t length) {
  if (length == 0 || (key[0] >= '0' && key[0] <= '9')) return false;
  for (size_t i = 0; i < length; i++) {
    char c = key[i];
    bool ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_';
    if (!ok) return false;
  }
  return true;
}

static bool key_is(const char *key, size_t length, const char *name) {
  return strlen(name) == length && memcmp(key, name, length) == 0;
}

static bool key_denied(const char *key, size_t length) {
  for (size_t i = 0; i < COUNT(ALLOWED_ARCHON); i++)
    if (key_is(key, length, ALLOWED_ARCHON[i])) return false;
  for (size_t i = 0; i < COUNT(DENIED_EXACT); i++)
    if (key_is(key, length, DENIED_EXACT[i])) return true;
  for (size_t i = 0; i < COUNT(DENIED_PREFIX); i++) {
    size_t prefix = strlen(DENIED_PREFIX[i]);
    if (length >= prefix && memcmp(key, DENIED_PREFIX[i], prefix) == 0) return true;
  }
  return false;
}

static char *read_env_block(size_t *size) {
  char *block = malloc(MAX_ENV_BYTES + 1);
  if (!block) refuse("out of memory");
  size_t used = 0;
  for (;;) {
    ssize_t n = read(ENV_FD, block + used, MAX_ENV_BYTES + 1 - used);
    if (n < 0 && errno == EINTR) continue;
    if (n < 0) refuse("environment fd %d is not readable: %s", ENV_FD, strerror(errno));
    if (n == 0) break;
    used += (size_t)n;
    if (used > MAX_ENV_BYTES) refuse("environment block is larger than %d bytes", MAX_ENV_BYTES);
  }
  *size = used;
  return block;
}

/* Keys are checked before any is echoed, and values are never echoed. */
static char **parse_env(char *block, size_t size) {
  static char *records[MAX_ENV_RECORDS + 5];
  size_t count = 0;
  if (size > 0 && block[size - 1] != '\0') refuse("environment block is truncated");
  for (size_t at = 0; at < size;) {
    char *record = block + at;
    size_t length = strlen(record);
    char *equals = memchr(record, '=', length);
    if (!equals) refuse("environment record %zu has no '='", count);
    size_t key_length = (size_t)(equals - record);
    if (!valid_key(record, key_length)) refuse("environment record %zu has an invalid key", count);
    if (key_denied(record, key_length))
      refuse("environment key %.*s is not allowed", (int)key_length, record);
    at += length + 1;
    if (key_is(record, key_length, "HOME") || key_is(record, key_length, "USER") ||
        key_is(record, key_length, "LOGNAME") || key_is(record, key_length, "PATH"))
      continue;
    for (size_t i = 0; i < count; i++)
      if (strncmp(records[i], record, key_length + 1) == 0)
        refuse("environment key %.*s appears twice", (int)key_length, record);
    if (count == MAX_ENV_RECORDS) refuse("more than %d environment records", MAX_ENV_RECORDS);
    records[count++] = record;
  }
  records[count++] = "HOME=" AGENT_HOME;
  records[count++] = "USER=" AGENT_USER;
  records[count++] = "LOGNAME=" AGENT_USER;
  records[count++] = "PATH=" AGENT_PATH;
  records[count] = NULL;
  return records;
}

static bool cwd_in_allowed_root(char *const *parts, size_t depth) {
  if (depth < 3 || strcmp(parts[0], ".archon") != 0) return false;
  if (strcmp(parts[1], "worktrees") == 0) return true;
  return strcmp(parts[1], "workspaces") == 0 && depth >= 6 &&
         (strcmp(parts[4], "worktrees") == 0 || strcmp(parts[4], "artifacts") == 0);
}

/* Walks one component at a time so that no component can be a symlink. The final chdir uses the
 * descriptor, so swapping a path component after this check cannot redirect it. */
static void enter_cwd(const char *path) {
  char copy[PATH_MAX];
  char *parts[MAX_CWD_DEPTH];
  size_t depth = 0;
  if (path[0] != '/' || strlen(path) >= sizeof(copy)) refuse("--cwd must be an absolute path");
  strcpy(copy, path + 1);
  char *rest = copy;
  for (;;) {
    char *slash = strchr(rest, '/');
    if (slash) *slash = '\0';
    if (rest[0] == '\0' || strcmp(rest, ".") == 0 || strcmp(rest, "..") == 0)
      refuse("--cwd %s has an empty, '.' or '..' component", path);
    if (depth == MAX_CWD_DEPTH) refuse("--cwd %s is too deep", path);
    parts[depth++] = rest;
    if (!slash) break;
    rest = slash + 1;
  }
  if (!cwd_in_allowed_root(parts, depth)) refuse("--cwd %s is outside the allowed roots", path);
  int dir = open("/", O_PATH | O_DIRECTORY | O_CLOEXEC);
  if (dir < 0) refuse("cannot open /: %s", strerror(errno));
  for (size_t i = 0; i < depth; i++) {
    int next = openat(dir, parts[i], O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (next < 0) refuse("--cwd %s: component %s: %s", path, parts[i], strerror(errno));
    close(dir);
    dir = next;
  }
  if (fchdir(dir) != 0) refuse("--cwd %s: %s", path, strerror(errno));
  close(dir);
}

static void signal_children(int sig) {
  char path[64];
  snprintf(path, sizeof(path), "/proc/self/task/%d/children", (int)getpid());
  FILE *file = fopen(path, "re");
  if (!file) return; /* The group signal has already been sent; the exit loop keeps escalating. */
  int pid;
  while (fscanf(file, "%d", &pid) == 1) kill(pid, sig);
  fclose(file);
}

static long now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return ts.tv_sec * 1000L + ts.tv_nsec / 1000000L;
}

static int supervise(pid_t leader, int signals) {
  int control = CONTROL_FD;
  bool leader_done = false;
  bool terminating = false;
  int status = 0;
  long deadline = 0;

  for (;;) {
    pid_t reaped;
    int reaped_status;
    bool any_reaped = false;
    while ((reaped = waitpid(-1, &reaped_status, WNOHANG)) > 0) {
      any_reaped = true;
      if (reaped == leader) {
        status = reaped_status;
        leader_done = true;
      }
    }
    if (reaped < 0 && errno == ECHILD) break;
    /* An exit can reparent escaped descendants here; they have not been signalled yet. */
    if (any_reaped && terminating) signal_children(SIGTERM);

    int forward = 0;
    if (leader_done && !terminating) forward = SIGTERM;

    struct pollfd fds[2] = {{signals, POLLIN, 0}, {control, POLLIN, 0}};
    if (forward == 0) {
      int timeout = terminating ? KILL_RETRY_MS : -1;
      if (poll(fds, 2, timeout) < 0 && errno != EINTR) refuse("poll: %s", strerror(errno));
      if (fds[0].revents & POLLIN) {
        struct signalfd_siginfo info;
        if (read(signals, &info, sizeof(info)) == (ssize_t)sizeof(info) &&
            info.ssi_signo != SIGCHLD)
          forward = (int)info.ssi_signo;
      }
      if (control >= 0 && fds[1].revents != 0) {
        char drain[64];
        ssize_t n = read(control, drain, sizeof(drain));
        if (n == 0 || (n < 0 && errno != EINTR && errno != EAGAIN)) {
          close(control);
          control = -1;
          forward = SIGTERM;
        }
      }
    }
    if (forward != 0) {
      if (!terminating) deadline = now_ms() + EXIT_GRACE_MS;
      terminating = true;
      kill(-leader, forward);
      signal_children(forward);
    }
    if (terminating && now_ms() >= deadline) {
      kill(-leader, SIGKILL);
      signal_children(SIGKILL);
    }
  }
  return WIFSIGNALED(status) ? 128 + WTERMSIG(status) : WEXITSTATUS(status);
}

int main(int argc, char **argv) {
  if (getuid() != AGENT_UID || geteuid() != AGENT_UID)
    refuse("must run as uid %d through sudo", AGENT_UID);

  /* Strict grammar: there is no other way to spell these arguments. */
  const char *cwd = NULL;
  int program;
  if (argc >= 4 && strcmp(argv[1], "--home") == 0 && strcmp(argv[2], "--") == 0) {
    program = 3;
  } else if (argc >= 5 && strcmp(argv[1], "--cwd") == 0 && strcmp(argv[3], "--") == 0) {
    cwd = argv[2];
    program = 4;
  } else {
    refuse("usage: archon-agent-exec (--cwd <dir> | --home) -- <program> [args...]");
  }

  if (fcntl(CONTROL_FD, F_GETFD) < 0) refuse("control fd %d is not open", CONTROL_FD);
  size_t size;
  char *block = read_env_block(&size);
  char **child_env = parse_env(block, size);
  close(ENV_FD);

  if (cwd) {
    enter_cwd(cwd);
  } else if (chdir(AGENT_HOME) != 0) {
    refuse("--home: %s", strerror(errno));
  }

  /* Blocked before fork so that no signal is lost between fork and the signalfd. */
  sigset_t handled, original;
  sigemptyset(&handled);
  sigaddset(&handled, SIGTERM);
  sigaddset(&handled, SIGINT);
  sigaddset(&handled, SIGHUP);
  sigaddset(&handled, SIGCHLD);
  if (sigprocmask(SIG_BLOCK, &handled, &original) != 0) refuse("sigprocmask failed");
  int signals = signalfd(-1, &handled, SFD_CLOEXEC);
  if (signals < 0) refuse("signalfd: %s", strerror(errno));

  /* Reparents escaped descendants here, so they can be found and ended. */
  if (prctl(PR_SET_CHILD_SUBREAPER, 1) != 0) refuse("subreaper: %s", strerror(errno));
  /* Sudo forks to run this, so the parent is sudo. Its death arrives as a SIGTERM. */
  pid_t sudo = getppid();
  if (prctl(PR_SET_PDEATHSIG, SIGTERM) != 0) refuse("pdeathsig: %s", strerror(errno));
  if (getppid() != sudo) refuse("parent exited during startup");

  /* Closes on exec. EOF means setsid and exec both happened; bytes carry exec's errno. */
  int sync[2];
  if (pipe2(sync, O_CLOEXEC) != 0) refuse("pipe: %s", strerror(errno));

  pid_t leader = fork();
  if (leader < 0) refuse("fork: %s", strerror(errno));
  if (leader == 0) {
    int error = 0;
    close(sync[0]);
    if (setsid() < 0 || close_range(3, ~0U, CLOSE_RANGE_CLOEXEC) != 0) {
      error = errno;
    } else {
      umask(0002);
      sigprocmask(SIG_SETMASK, &original, NULL);
      environ = child_env;
      execvp(argv[program], &argv[program]);
      error = errno;
    }
    if (write(sync[1], &error, sizeof(error)) < 0) _exit(EXIT_REFUSED);
    _exit(EXIT_EXEC_FAILED);
  }
  close(sync[1]);
  int exec_error = 0;
  ssize_t n;
  do {
    n = read(sync[0], &exec_error, sizeof(exec_error));
  } while (n < 0 && errno == EINTR);
  close(sync[0]);
  if (n > 0) {
    fprintf(stderr, "archon-agent-exec: cannot run %s: %s\n", argv[program], strerror(exec_error));
    waitpid(leader, NULL, 0);
    _exit(EXIT_EXEC_FAILED);
  }

  return supervise(leader, signals);
}
