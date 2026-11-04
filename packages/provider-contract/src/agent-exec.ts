/**
 * The seam for running untrusted execution as the archon-agent user. It only computes what to
 * spawn, so every spawn site keeps its own process handling. See deploy/agent-exec/.
 */

const AGENT_USER = 'archon-agent';
const AGENT_EXEC_PATH = '/usr/local/sbin/archon-agent-exec';

/** The wrapper keeps fds below this open: 3 carries the environment, 4 is the control pipe. */
const SUDO_CLOSE_FROM = '5';

/** Non-secret host settings a subprocess may inherit. Exact names, never a prefix. */
const AGENT_BASE_ENV_KEYS = [
  'TERM',
  'LANG',
  'LC_ALL',
  'TZ',
  'NO_PROXY',
  'HTTP_PROXY',
  'HTTPS_PROXY',
] as const;

/**
 * The ARCHON_* names a node may receive. The wrapper enforces the same list:
 * agent-exec.test.ts compares this with archon-agent-exec.c, and exec-environment.test.ts with
 * what the engine delivers.
 */
export const AGENT_ARCHON_ENV_KEYS = [
  'ARCHON_RUN_ENV_KEYS',
  'ARCHON_NODE_EXECUTION',
  'ARCHON_CLI_COMMAND',
] as const;

export class AgentExecConfigError extends Error {
  override readonly name = 'AgentExecConfigError';
}

/**
 * Whether isolation is on. Anything other than unset or the one supported user is an error:
 * treating a mistyped value as "off" would run agents with the server's credentials.
 */
export function isAgentIsolationEnabled(
  value: string | undefined = process.env.ARCHON_AGENT_USER
): boolean {
  if (value === undefined) return false;
  if (value === AGENT_USER) return true;
  throw new AgentExecConfigError(`ARCHON_AGENT_USER must be unset or ${AGENT_USER}`);
}

/**
 * The environment for an isolated subprocess: named host settings plus the managed bag, never a
 * spread of `process.env`. A database key in the bag is a misconfiguration, so it fails instead of
 * being dropped. The message carries the key and never its value.
 */
export function buildAgentSubprocessEnv(
  managedEnv: Readonly<Record<string, string>> | undefined,
  hostEnv: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of AGENT_BASE_ENV_KEYS) {
    const value = hostEnv[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(managedEnv ?? {})) {
    if (key === 'DATABASE_URL' || key.startsWith('PG')) {
      throw new AgentExecConfigError(`Environment key ${key} must not reach an agent process`);
    }
    env[key] = value;
  }
  return env;
}

/** NUL-terminated KEY=VALUE records, the format the wrapper reads from fd 3. */
function encodeAgentEnv(env: Readonly<Record<string, string>>): Buffer {
  const records = Object.entries(env).map(([key, value]) => {
    // Node refuses NUL in a normal spawn; here it would split one record into two.
    if (key.includes('\0') || value.includes('\0')) {
      throw new AgentExecConfigError(`Environment key ${key.replace(/\0/g, '')} contains NUL`);
    }
    return `${key}=${value}\0`;
  });
  return Buffer.from(records.join(''), 'utf8');
}

export interface AgentSpawnRequest {
  argv: readonly [string, ...string[]];
  /** The working directory, or `home` for a call that has none, such as a credential check. */
  location: { cwd: string } | 'home';
  env: Readonly<Record<string, string>>;
}

export interface AgentSpawnPlan {
  command: 'sudo';
  args: string[];
  /** Sudo's own environment. The program's travels in `envBlock`. */
  env: { PATH: string };
  envBlock: Buffer;
}

export function planAgentSpawn(request: AgentSpawnRequest): AgentSpawnPlan {
  const location = request.location === 'home' ? ['--home'] : ['--cwd', request.location.cwd];
  return {
    command: 'sudo',
    args: [
      '-n',
      '-C',
      SUDO_CLOSE_FROM,
      '-u',
      AGENT_USER,
      AGENT_EXEC_PATH,
      ...location,
      '--',
      ...request.argv,
    ],
    env: { PATH: '/usr/bin:/bin' },
    envBlock: encodeAgentEnv(request.env),
  };
}

/** Spawn `stdio` for a plan: the caller's three streams, then the environment and control pipes. */
export const AGENT_EXTRA_STDIO = ['pipe', 'pipe'] as const;

interface AgentChild {
  pid?: number | undefined;
  stdio: readonly unknown[];
}

interface WritablePipe {
  end(chunk?: Uint8Array): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

/**
 * Sends the environment and returns the function that releases the control pipe. The pipe must
 * stay open for the life of the process, because closing it ends the tree. A write error means the
 * wrapper already exited, which the caller sees as the child's exit status. A spawn that failed has
 * no pid and reports through the child's `error` event, so it is left for that handler.
 */
export function startAgentPipes(child: AgentChild, plan: AgentSpawnPlan): () => void {
  if (child.pid === undefined) return () => undefined;
  const envPipe = child.stdio[3] as WritablePipe | null | undefined;
  const controlPipe = child.stdio[4] as WritablePipe | null | undefined;
  if (!envPipe || !controlPipe) {
    throw new AgentExecConfigError('An agent spawn needs pipes on fds 3 and 4');
  }
  envPipe.on('error', () => undefined);
  controlPipe.on('error', () => undefined);
  envPipe.end(plan.envBlock);
  return () => {
    controlPipe.end();
  };
}
