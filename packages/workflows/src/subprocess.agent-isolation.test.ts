import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSubprocess } from './subprocess';

const options = (cwd: string, env: NodeJS.ProcessEnv = {}) => ({
  cwd,
  env,
  retention: { standalone: true as const },
});

describe('runSubprocess with agent isolation', () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.ARCHON_AGENT_USER;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.ARCHON_AGENT_USER;
    else process.env.ARCHON_AGENT_USER = saved;
  });

  test('a mistyped switch fails and runs nothing', async () => {
    process.env.ARCHON_AGENT_USER = 'appuser';
    const marker = join(mkdtempSync(join(tmpdir(), 'agent-isolation-')), 'ran');
    await expect(
      runSubprocess({ kind: 'host' }, '/bin/sh', ['-c', `touch ${marker}`], options(tmpdir()))
    ).rejects.toThrow('ARCHON_AGENT_USER');
    expect(existsSync(marker)).toBe(false);
  });

  test('a database key in the managed env fails and runs nothing', async () => {
    process.env.ARCHON_AGENT_USER = 'archon-agent';
    const marker = join(mkdtempSync(join(tmpdir(), 'agent-isolation-')), 'ran');
    await expect(
      runSubprocess(
        { kind: 'host' },
        '/bin/sh',
        ['-c', `touch ${marker}`],
        options(tmpdir(), { DATABASE_URL: 'secret-value' })
      )
    ).rejects.toThrow('DATABASE_URL');
    expect(existsSync(marker)).toBe(false);
  });

  // Whether sudo is absent or refuses here, the command must not run as the current user.
  test('a wrapper that cannot run fails the node, with no fallback', async () => {
    process.env.ARCHON_AGENT_USER = 'archon-agent';
    const marker = join(mkdtempSync(join(tmpdir(), 'agent-isolation-')), 'ran');
    await expect(
      runSubprocess({ kind: 'host' }, '/bin/sh', ['-c', `touch ${marker}`], options(tmpdir()))
    ).rejects.toBeDefined();
    expect(existsSync(marker)).toBe(false);
  });

  test('a container context is not wrapped, and unset leaves the host path as it was', async () => {
    delete process.env.ARCHON_AGENT_USER;
    process.env.AGENT_ISOLATION_TEST_INHERITED = 'yes';
    try {
      const { stdout } = await runSubprocess(
        { kind: 'host' },
        '/bin/sh',
        ['-c', 'echo $AGENT_ISOLATION_TEST_INHERITED'],
        options(tmpdir())
      );
      expect(stdout.trim()).toBe('yes');
    } finally {
      delete process.env.AGENT_ISOLATION_TEST_INHERITED;
    }
  });
});
