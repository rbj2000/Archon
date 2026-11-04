import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AGENT_ARCHON_ENV_KEYS,
  AGENT_EXTRA_STDIO,
  AgentExecConfigError,
  buildAgentSubprocessEnv,
  isAgentIsolationEnabled,
  planAgentSpawn,
  startAgentPipes,
} from './agent-exec';

describe('isAgentIsolationEnabled', () => {
  test('is off only when unset', () => {
    expect(isAgentIsolationEnabled(undefined)).toBe(false);
  });

  test('is on for the supported user', () => {
    expect(isAgentIsolationEnabled('archon-agent')).toBe(true);
  });

  test.each(['', 'appuser', 'root', 'ARCHON-AGENT', 'archon-agent '])('rejects %j', value => {
    expect(() => isAgentIsolationEnabled(value)).toThrow(AgentExecConfigError);
  });
});

describe('buildAgentSubprocessEnv', () => {
  test('never inherits a host key outside the allowlist', () => {
    const env = buildAgentSubprocessEnv(undefined, {
      TERM: 'xterm',
      HTTPS_PROXY: 'http://proxy',
      DATABASE_URL: 'sentinel',
      PGPASSWORD: 'sentinel',
      ARCHON_SECRET: 'sentinel',
      ANTHROPIC_API_KEY: 'sentinel',
      TERMINAL: 'sentinel',
      HOME: 'sentinel',
      PATH: 'sentinel',
    });
    expect(env).toEqual({ TERM: 'xterm', HTTPS_PROXY: 'http://proxy' });
  });

  test('does not read process.env beyond the allowlist by default', () => {
    process.env.AGENT_EXEC_TEST_SENTINEL = 'sentinel';
    try {
      expect(buildAgentSubprocessEnv({})).not.toHaveProperty('AGENT_EXEC_TEST_SENTINEL');
    } finally {
      delete process.env.AGENT_EXEC_TEST_SENTINEL;
    }
  });

  test('includes the managed bag, which wins over host settings', () => {
    expect(
      buildAgentSubprocessEnv({ TERM: 'dumb', ANTHROPIC_API_KEY: 'k' }, { TERM: 'x' })
    ).toEqual({
      TERM: 'dumb',
      ANTHROPIC_API_KEY: 'k',
    });
  });

  test.each(['DATABASE_URL', 'PGHOST', 'PGPASSWORD'])('fails on %s and hides the value', key => {
    expect(() => buildAgentSubprocessEnv({ [key]: 'secret-value' }, {})).toThrow(key);
    try {
      buildAgentSubprocessEnv({ [key]: 'secret-value' }, {});
    } catch (error) {
      expect(String(error)).not.toContain('secret-value');
    }
  });
});

describe('planAgentSpawn', () => {
  test('builds the exact sudo command for a working directory', () => {
    const plan = planAgentSpawn({ argv: ['bash', '-c', 'x y'], location: { cwd: '/w' }, env: {} });
    expect(plan.command).toBe('sudo');
    expect(plan.args).toEqual([
      '-n',
      '-C',
      '5',
      '-u',
      'archon-agent',
      '/usr/local/sbin/archon-agent-exec',
      '--cwd',
      '/w',
      '--',
      'bash',
      '-c',
      'x y',
    ]);
  });

  test('uses --home for a call without a working directory', () => {
    const plan = planAgentSpawn({ argv: ['id'], location: 'home', env: {} });
    expect(plan.args.slice(6)).toEqual(['--home', '--', 'id']);
  });

  test('gives sudo only a fixed PATH, and keeps secrets out of argv', () => {
    const plan = planAgentSpawn({ argv: ['id'], location: 'home', env: { KEY: 'secret-value' } });
    expect(plan.env).toEqual({ PATH: '/usr/bin:/bin' });
    expect(plan.args.join(' ')).not.toContain('secret-value');
  });

  test('encodes values with newlines, equals signs, unicode and empty strings', () => {
    const env = { A: 'line1\nline2', B: 'x=y', C: 'čšž', D: '' };
    const { envBlock } = planAgentSpawn({ argv: ['id'], location: 'home', env });
    expect(envBlock.toString('utf8')).toBe('A=line1\nline2\0B=x=y\0C=čšž\0D=\0');
  });

  test('encodes an empty environment as no bytes', () => {
    expect(planAgentSpawn({ argv: ['id'], location: 'home', env: {} }).envBlock.length).toBe(0);
  });

  test('refuses NUL, which would forge a second record', () => {
    expect(() =>
      planAgentSpawn({ argv: ['id'], location: 'home', env: { A: 'x\0DATABASE_URL=y' } })
    ).toThrow(AgentExecConfigError);
  });
});

describe('startAgentPipes', () => {
  test('refuses a child without the extra pipes', () => {
    const plan = planAgentSpawn({ argv: ['id'], location: 'home', env: {} });
    expect(() => startAgentPipes({ pid: 1, stdio: [null, null, null] }, plan)).toThrow(
      AgentExecConfigError
    );
  });

  test('leaves a failed spawn to the child error handler', () => {
    const plan = planAgentSpawn({ argv: ['id'], location: 'home', env: {} });
    expect(() => startAgentPipes({ stdio: [] }, plan)()).not.toThrow();
  });

  // The extra fds are what the wrapper depends on, so this uses a real spawn under Bun.
  test('delivers the block on fd 3 and holds fd 4 open until released', async () => {
    const plan = planAgentSpawn({ argv: ['id'], location: 'home', env: { KEY: 'value' } });
    const child = spawn(
      '/bin/sh',
      ['-c', 'tr "\\0" "\\n" <&3; echo opened; cat <&4; echo closed'],
      {
        stdio: ['ignore', 'pipe', 'inherit', ...AGENT_EXTRA_STDIO],
      }
    );
    const release = startAgentPipes(child, plan);
    let output = '';
    const seen = new Promise<void>(done => {
      child.stdout?.on('data', (data: Buffer) => {
        output += data.toString();
        if (output.includes('opened')) done();
      });
    });
    const exited = new Promise<void>(done => child.once('close', () => done()));
    await seen;
    await Bun.sleep(100);
    expect(output).toBe('KEY=value\nopened\n');
    release();
    await exited;
    expect(output).toBe('KEY=value\nopened\nclosed\n');
  });
});

describe('agreement with the wrapper', () => {
  const source = readFileSync(
    resolve(import.meta.dir, '../../../deploy/agent-exec/archon-agent-exec.c'),
    'utf8'
  );

  test('the allowed ARCHON_* keys match the C list', () => {
    const block = /ALLOWED_ARCHON\[\] = \{([^}]*)\}/.exec(source)?.[1] ?? '';
    const inC = [...block.matchAll(/"([A-Z_]+)"/g)].map(match => match[1]);
    expect(inC.sort()).toEqual([...AGENT_ARCHON_ENV_KEYS].sort());
  });

  test('the plan keeps the fds the wrapper reads', () => {
    expect(source).toContain('#define ENV_FD 3');
    expect(source).toContain('#define CONTROL_FD 4');
    expect(source).toContain('sudo -n -C 5 -u archon-agent');
  });

  test('the sudoers rule names the path the plan runs', () => {
    const sudoers = readFileSync(
      resolve(import.meta.dir, '../../../deploy/agent-exec/sudoers'),
      'utf8'
    );
    const plan = planAgentSpawn({ argv: ['id'], location: 'home', env: {} });
    expect(sudoers).toContain(`(archon-agent) NOPASSWD: NOSETENV: ${plan.args[5]}`);
  });
});
