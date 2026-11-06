/**
 * Git with agent isolation on. Git that reads an agent-writable tree runs as the agent user, because
 * Phase 0 ran code as the server's user through an edited `worktrees/<n>/commondir` with every flag
 * below applied. The flags stay as defence in depth; the permissions on `source/.git/config` close
 * what flags cannot (`include.path`, `filter.*`, `textconv`).
 */
// A namespace import: packages mock this module partially, and a named import would fail to load.
import * as childProcess from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  AGENT_EXTRA_STDIO,
  buildAgentSubprocessEnv,
  isAgentWritablePath,
  planAgentSpawn,
  startAgentPipes,
} from '@archon/provider-contract';

const HARDENING_ARGS = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.sshCommand=/bin/false',
  '-c',
  'protocol.allow=never',
  '-c',
  'protocol.https.allow=always',
  '-c',
  'protocol.file.allow=never',
  '-c',
  'submodule.recurse=false',
  '-c',
  'diff.external=',
  '-c',
  'core.pager=cat',
  // Refs and logs must stay writable by both users whatever umask the caller has, such as a CLI
  // started by `docker exec`. `.git/config` stays in the server's own group, so this cannot open it.
  '-c',
  'core.sharedRepository=group',
];

const DEFAULT_MAX_BUFFER = 1024 * 1024;

export interface IsolatedGitOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  maxBuffer?: number;
  killSignal?: NodeJS.Signals;
  windowsHide?: boolean;
  input?: string | Buffer;
}

export interface IsolatedGitResult {
  stdout: Buffer;
  stderr: Buffer;
}

interface ResolvedPath {
  path: string;
  exists: boolean;
}

/** The real path, or for a missing path the real path of its nearest existing parent plus the rest. */
async function resolveReal(path: string): Promise<ResolvedPath> {
  try {
    return { path: await realpath(path), exists: true };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if ((code !== 'ENOENT' && code !== 'ENOTDIR') || dirname(path) === path) throw error;
    const parent = await resolveReal(dirname(path));
    return { path: join(parent.path, basename(path)), exists: false };
  }
}

interface GitLocations {
  /** Where git will start: `cwd` with every leading `-C` applied. */
  start: string;
  /** `--git-dir` and `--work-tree` values, which select a tree without moving the start. */
  selected: string[];
  /** The arguments with leading `-C` removed, for a process already started at `start`. */
  argsWithoutStart: string[];
}

function readLocations(args: readonly string[], cwd: string | undefined): GitLocations {
  let start = resolve(cwd ?? process.cwd());
  const selected: string[] = [];
  const rest: string[] = [];
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-C') {
      start = resolve(start, args[++i]);
    } else if (arg === '-c' || arg === '--git-dir' || arg === '--work-tree') {
      const value = args[++i];
      if (arg !== '-c') selected.push(value);
      rest.push(arg, value);
    } else if (arg.startsWith('--git-dir=') || arg.startsWith('--work-tree=')) {
      selected.push(arg.slice(arg.indexOf('=') + 1));
      rest.push(arg);
    } else if (arg.startsWith('-')) {
      rest.push(arg);
    } else {
      break;
    }
  }
  return {
    start,
    selected: selected.map(path => resolve(start, path)),
    argsWithoutStart: [...rest, ...args.slice(i)],
  };
}

/** Whether these arguments reach a tree the agent can write, so they must not run as the server. */
export async function gitRunsAsAgent(args: readonly string[], cwd?: string): Promise<boolean> {
  const { start, selected } = readLocations(args, cwd);
  const paths = await Promise.all([start, ...selected].map(resolveReal));
  return paths.some(({ path }) => isAgentWritablePath(path));
}

/** What the caller set itself. A spread of `process.env` carries the server's secrets otherwise. */
function callerEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> {
  const own: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value !== undefined && process.env[key] !== value) own[key] = value;
  }
  return own;
}

/** The server's environment with inherited `GIT_*` dropped, so nothing inherited selects a repo. */
function serverGitEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
  );
  return {
    ...inherited,
    ...callerEnv(env),
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
  };
}

interface FailureFields {
  code: number | string | null;
  killed: boolean;
  stdout: string;
  stderr: string;
  stdoutBuffer: Buffer;
}

function gitError(message: string, fields: FailureFields): Error & FailureFields {
  return Object.assign(new Error(message), fields);
}

/** Runs one program as the agent user, with the same failure shape as promisified `execFile`. */
function runAsAgent(
  argv: readonly [string, ...string[]],
  cwd: string,
  options: IsolatedGitOptions
): Promise<IsolatedGitResult> {
  const plan = planAgentSpawn({
    argv,
    location: { cwd },
    env: buildAgentSubprocessEnv({ ...callerEnv(options.env), GIT_TERMINAL_PROMPT: '0' }),
  });
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  return new Promise((resolvePromise, reject) => {
    const child = childProcess.spawn(plan.command, plan.args, {
      env: plan.env,
      stdio: ['pipe', 'pipe', 'pipe', ...AGENT_EXTRA_STDIO],
    });
    const release = startAgentPipes(child, plan);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let killed = false;
    let overflow = false;
    const kill = (): void => {
      killed = true;
      child.kill(options.killSignal ?? 'SIGTERM');
    };
    const collect =
      (into: Buffer[]) =>
      (chunk: Buffer): void => {
        size += chunk.length;
        if (size > maxBuffer) {
          overflow = true;
          kill();
          return;
        }
        into.push(chunk);
      };
    child.stdout.on('data', collect(out));
    child.stderr.on('data', collect(err));
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.input);
    const timer = options.timeout ? setTimeout(kill, options.timeout) : undefined;
    const finish = (code: number | string | null): void => {
      if (timer) clearTimeout(timer);
      release();
      const stdout = Buffer.concat(out);
      const stderr = Buffer.concat(err);
      if (code === 0 && !killed) {
        resolvePromise({ stdout, stderr });
        return;
      }
      const reason = overflow ? 'output exceeded maxBuffer' : stderr.toString('utf8');
      reject(
        gitError(`Command failed: ${argv.join(' ')}\n${reason}`, {
          code,
          killed,
          stdout: stdout.toString('utf8'),
          stderr: stderr.toString('utf8'),
          stdoutBuffer: stdout,
        })
      );
    };
    child.on('error', error => {
      finish((error as NodeJS.ErrnoException).code ?? null);
    });
    child.on('close', code => {
      finish(code);
    });
  });
}

function runAsServer(args: string[], options: IsolatedGitOptions): Promise<IsolatedGitResult> {
  const { input, env, ...execOptions } = options;
  return new Promise((resolvePromise, reject) => {
    const child = childProcess.execFile(
      'git',
      args,
      {
        windowsHide: true,
        maxBuffer: DEFAULT_MAX_BUFFER,
        ...execOptions,
        env: serverGitEnv(env),
        encoding: 'buffer',
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolvePromise({ stdout, stderr });
          return;
        }
        reject(
          Object.assign(error, {
            stdout: stdout.toString('utf8'),
            stderr: stderr.toString('utf8'),
            stdoutBuffer: stdout,
          })
        );
      }
    );
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(input);
  });
}

/**
 * `git worktree remove` reads a checkout the agent controls: without `--force` it runs `git status`
 * inside it as the caller. So the agent user answers that question, and hands its files back to the
 * shared group, since a directory it closed to the group would stop the server deleting it.
 */
async function prepareWorktreeRemoval(
  worktreePath: string,
  forced: boolean,
  options: IsolatedGitOptions
): Promise<void> {
  const target = await resolveReal(worktreePath);
  if (!target.exists || !isAgentWritablePath(target.path)) return;
  if (!forced) {
    const { stdout } = await runAsAgent(
      ['git', ...HARDENING_ARGS, 'status', '--porcelain', '--ignore-submodules=none'],
      target.path,
      options
    );
    if (stdout.length > 0) {
      throw gitError(
        `fatal: '${worktreePath}' contains modified or untracked files, use --force to delete it`,
        {
          code: 128,
          killed: false,
          stdout: '',
          stderr: `fatal: '${worktreePath}' contains modified or untracked files, use --force to delete it\n`,
          stdoutBuffer: Buffer.alloc(0),
        }
      );
    }
  }
  await runAsAgent(
    [
      'find',
      target.path,
      '-user',
      'archon-agent',
      '!',
      '-type',
      'l',
      '-exec',
      'chgrp',
      'archon-work',
      '{}',
      '+',
      '-exec',
      'chmod',
      'g+rwX',
      '{}',
      '+',
    ],
    target.path,
    options
  );
}

/**
 * Runs git as whichever user the location allows. A failure to run as the agent user stays a
 * failure: there is deliberately no retry as the server's user.
 */
export async function runIsolatedGit(
  args: string[],
  options: IsolatedGitOptions = {}
): Promise<IsolatedGitResult> {
  const { start, argsWithoutStart } = readLocations(args, options.cwd);
  if (await gitRunsAsAgent(args, options.cwd)) {
    const startPath = await resolveReal(start);
    // Nothing may run here as the server to report this, and the wrapper refuses a missing cwd.
    if (!startPath.exists) {
      throw gitError(`Command failed: git: cannot change to '${start}'`, {
        code: 'ENOENT',
        killed: false,
        stdout: '',
        stderr: `fatal: cannot change to '${start}': No such file or directory\n`,
        stdoutBuffer: Buffer.alloc(0),
      });
    }
    return runAsAgent(['git', ...HARDENING_ARGS, ...argsWithoutStart], startPath.path, options);
  }
  let serverArgs = args;
  const verb = argsWithoutStart.indexOf('worktree');
  if (verb !== -1 && argsWithoutStart[verb + 1] === 'remove') {
    const forced = argsWithoutStart.includes('--force');
    await prepareWorktreeRemoval(
      resolve(start, argsWithoutStart[argsWithoutStart.length - 1]),
      forced,
      options
    );
    if (!forced) {
      const at = args.indexOf('remove');
      serverArgs = [...args.slice(0, at + 1), '--force', ...args.slice(at + 1)];
    }
  }
  return runAsServer([...HARDENING_ARGS, ...serverArgs], options);
}
