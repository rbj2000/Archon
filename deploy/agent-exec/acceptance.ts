// Drives the real engine code against the real wrapper, as appuser, inside the built image.
// acceptance.sh prepares the container and starts this.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { recordNodeProcessTrees, runSubprocess } from '/app/packages/workflows/src/subprocess.ts';
import { processProviderRegistration } from '/app/packages/core/src/providers/process-registration.ts';
import { descriptor } from '/app/packages/core/src/providers/fixtures/process-provider-data.ts';

const WT = '/.archon/workspaces/o/r/worktrees/wt';
const FIXTURE = '/app/packages/core/src/providers/fixtures/process-provider.ts';
const SENTINEL = 'acceptance-sentinel';
const host = { kind: 'host' } as const;
const base = { cwd: WT, env: {}, retention: { standalone: true } as const };

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `: ${detail}`}`);
  if (!ok) failed++;
}
const run = (script: string, env: NodeJS.ProcessEnv = {}, extra: object = {}) =>
  runSubprocess(host, '/bin/bash', ['-c', script], { ...base, env, ...extra });
const agentCount = (pattern: string): number => {
  const out = spawnSync('pgrep', ['-u', '1201', '-c', '-f', pattern], { encoding: 'utf8' }).stdout;
  return Number(out.trim() || 0);
};
async function gone(pattern: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (agentCount(pattern) === 0) return true;
    await Bun.sleep(50);
  }
  return false;
}
async function started(pattern: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (agentCount(pattern) === 0 && Date.now() < deadline) await Bun.sleep(50);
}
const refused = async (promise: Promise<unknown>): Promise<boolean> =>
  promise.then(
    () => false,
    () => true
  );

if (process.argv[2] === 'owner') {
  // The owner the outer test kills with SIGKILL.
  recordNodeProcessTrees();
  await run('sleep 3101 & wait');
  process.exit(0);
}

console.log(`# running as uid ${process.getuid?.()}`);

// Identity and environment.
const { stdout: id } = await run('id -u; pwd -P');
check('node runs as archon-agent, in its worktree', id === `1201\n${WT}\n`, id);
const { stdout: env } = await run('env', { MANAGED: 'yes', ARCHON_NODE_EXECUTION: '{}' });
check('server secrets do not reach a node', !env.includes(SENTINEL), env);
check('no database keys reach a node', !/^(DATABASE_URL|PG[A-Z]*)=/m.test(env), env);
check('managed env arrives', env.includes('MANAGED=yes'));
check('allowed ARCHON key arrives', env.includes('ARCHON_NODE_EXECUTION={}'));
check('fixed HOME', env.includes('HOME=/home/archon-agent'));

// Reach.
for (const [name, script] of [
  ['read server environ', 'cat /proc/1/environ'],
  ['list /.archon', 'ls /.archon'],
  ['write /.archon', 'touch /.archon/x'],
  ['write /app', 'touch /app/x'],
  ['read /home/appuser', 'ls /home/appuser'],
  ['read another project log', 'ls /.archon/workspaces/o/r/logs'],
] as const) {
  check(`denied: ${name}`, await refused(run(script)));
}
const { stdout: wrote } = await run('echo hi > made && stat -c "%U %a" made');
check('can write its worktree, group-writable', wrote.startsWith('archon-agent 66'), wrote);

// Stdio, exit status, refusals.
const { stdout: echoed } = await run('cat', {}, { input: 'payload' });
check('stdin payload reaches the node', echoed === 'payload', echoed);
const failure = await run('echo oops >&2; exit 3').catch(
  (e: { code?: number; stderr?: string }) => e
);
check('exit status propagates', (failure as { code?: number }).code === 3);
check('stderr propagates', String((failure as { stderr?: string }).stderr).includes('oops'));
check(
  'cwd outside the roots fails',
  await refused(runSubprocess(host, '/bin/bash', ['-c', 'id'], { ...base, cwd: '/tmp' }))
);
check('wrapper-denied key fails', await refused(run('id', { NODE_OPTIONS: 'x' })));
check('database key fails', await refused(run('id', { DATABASE_URL: 'x' })));

// Setup path: its command is a shell, run with the owner-death lifeline.
const { stdout: setup } = await runSubprocess(host, '/bin/bash', ['-c', 'id -u'], {
  ...base,
  ownProcessGroup: true,
});
check('owned setup group runs as archon-agent', setup.trim() === '1201', setup);

// Termination: shared recorder, the mode `archon serve` uses.
{
  const trees = recordNodeProcessTrees();
  const controller = new AbortController();
  const node = run('sleep 3001 & wait', {}, { abortSignal: controller.signal }).catch(
    () => 'ended'
  );
  await started('sleep 3001');
  check('abort: tree started', agentCount('sleep 3001') > 0);
  controller.abort();
  check('abort ends the tree', await gone('sleep 3001', 3000));
  await node;
  const second = run('sleep 3002 & wait').catch(() => 'ended');
  await started('sleep 3002');
  await trees.end();
  check('end() ends a tree', await gone('sleep 3002', 3000));
  await second;
  trees.release();
}
{
  // Timeout: a tree that ignores SIGTERM still has to be gone within the grace period.
  const trees = recordNodeProcessTrees();
  await run('sleep 3003 & wait', {}, { timeout: 500, endTreeOnTimeout: true }).catch(() => 'ended');
  check('timeout ends the tree', await gone('sleep 3003', 3000));
  trees.release();
}
{
  // Detached owner: its end() confirms groups are gone within one second.
  const trees = recordNodeProcessTrees({ mode: 'detached-posix' });
  const node = run('trap "" TERM; sleep 3004 & wait').catch(() => 'ended');
  await started('sleep 3004');
  const prepared = trees.prepareTermination();
  await prepared.ready;
  let threw = '';
  await trees.end().catch((e: Error) => {
    threw = e.message;
  });
  check('detached end() confirms the tree gone', threw === '', threw);
  check('detached termination ends the tree', await gone('sleep 3004', 2000));
  prepared.release();
  await node;
  trees.release();
}
{
  // Owner death: nothing runs in the owner any more, so only the pipe can end the tree.
  const owner = spawn(process.execPath, [import.meta.path, 'owner'], { stdio: 'ignore' });
  await started('sleep 3101');
  check('owner: tree started', agentCount('sleep 3101') > 0);
  owner.kill('SIGKILL');
  check('SIGKILL of the owner ends the tree', await gone('sleep 3101', 3000));
}

// Providers.
const provider = (extra: string) =>
  processProviderRegistration(
    descriptor,
    ['/bin/sh', '-c', `${extra}; exec ${process.execPath} --no-env-file ${FIXTURE}`],
    'source'
  ).factory();
{
  const chunks: unknown[] = [];
  for await (const chunk of provider('id -u > provider-uid; env > provider-env').sendQuery(
    'hello',
    WT,
    undefined,
    { env: { PROVIDER_KEY: 'delivered' } }
  )) {
    chunks.push(chunk);
  }
  check('provider protocol works through sudo', chunks.length > 0);
  const uid = readFileSync(join(WT, 'provider-uid'), 'utf8').trim();
  const providerEnv = readFileSync(join(WT, 'provider-env'), 'utf8');
  check('provider runs as archon-agent', uid === '1201', uid);
  check('server secrets do not reach a provider', !providerEnv.includes(SENTINEL));
  check('managed env reaches a provider', providerEnv.includes('PROVIDER_KEY=delivered'));
}
{
  // The fixture's answer does not matter here, only where the process started.
  await provider('pwd > /tmp/acceptance-home')
    .checkCredential({ env: {}, signal: AbortSignal.timeout(10_000) } as never)
    .catch(() => undefined);
  check(
    'that call ran in the agent home',
    existsSync('/tmp/acceptance-home') &&
      readFileSync('/tmp/acceptance-home', 'utf8').includes('/home/archon-agent')
  );
}
check(
  'no agent process left behind',
  agentCount('.') === 0,
  spawnSync('ps', ['-u', '1201', '-o', 'pid,args'], { encoding: 'utf8' }).stdout
);

console.log(failed === 0 ? '# all passed' : `# ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
