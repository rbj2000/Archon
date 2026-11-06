import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { gitRunsAsAgent, runIsolatedGit } from './agent-git';
import { execFileAsync } from './exec';
import { GitFailure } from './errors';

// The agent path needs the real wrapper and uids, so deploy/agent-exec/acceptance-git.sh covers it.
describe('isolated git', () => {
  let dir: string;
  let saved: { user?: string; marker?: string };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-git-'));
    saved = {
      user: process.env.ARCHON_AGENT_USER,
      marker: process.env.GIT_DIR,
    };
    process.env.ARCHON_AGENT_USER = 'archon-agent';
  });
  afterEach(() => {
    if (saved.user === undefined) delete process.env.ARCHON_AGENT_USER;
    else process.env.ARCHON_AGENT_USER = saved.user;
    if (saved.marker === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = saved.marker;
    removeTempTree(dir);
  });

  test('outside an agent tree git runs as the server, hardened, without inherited GIT_*', async () => {
    const repo = join(dir, 'repo');
    execFileSync('git', ['init', '-q', repo]);
    // Inherited, this would select another repository.
    process.env.GIT_DIR = '/nonexistent';
    const { stdout } = await runIsolatedGit(['-C', repo, 'config', '--get', 'core.hooksPath']);
    expect(stdout.toString().trim()).toBe('/dev/null');
    const prompt = await runIsolatedGit(['-C', repo, 'config', '--get', 'protocol.allow']);
    expect(prompt.stdout.toString().trim()).toBe('never');
  });

  test('a real status works with every hardening flag', async () => {
    const repo = join(dir, 'repo');
    execFileSync('git', ['init', '-q', repo]);
    writeFileSync(join(repo, 'a'), 'a');
    const { stdout } = await execFileAsync('git', ['-C', repo, 'status', '--porcelain']);
    expect(stdout).toBe('?? a\n');
  });

  test('a failure outside an agent tree is still a classified GitFailure', async () => {
    const error = await execFileAsync('git', ['-C', join(dir, 'gone'), 'status']).catch(
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(GitFailure);
    expect((error as GitFailure).kind).toBe('not_repository');
  });

  test('a missing checkout in an agent tree fails without running anything', async () => {
    const error = await execFileAsync('git', [
      '-C',
      '/.archon/worktrees/definitely-missing',
      'status',
    ]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitFailure);
    expect((error as GitFailure).kind).toBe('not_repository');
  });

  test('routing follows the location, however it is spelled', async () => {
    const wt = '/.archon/worktrees/x';
    expect(await gitRunsAsAgent(['-C', wt, 'status'])).toBe(true);
    expect(await gitRunsAsAgent(['status'], wt)).toBe(true);
    expect(await gitRunsAsAgent(['--git-dir', `${wt}/.git`, 'status'], dir)).toBe(true);
    expect(await gitRunsAsAgent([`--work-tree=${wt}`, 'status'], dir)).toBe(true);
    expect(await gitRunsAsAgent(['-c', 'a=b', '-C', wt, 'status'], dir)).toBe(true);
    expect(await gitRunsAsAgent(['-C', dir, 'status'])).toBe(false);
    expect(await gitRunsAsAgent(['-C', dir, 'worktree', 'add', wt])).toBe(false);
  });

  test('with isolation off the plain path is used', async () => {
    delete process.env.ARCHON_AGENT_USER;
    const repo = join(dir, 'repo');
    execFileSync('git', ['init', '-q', repo]);
    const failed = await execFileAsync('git', [
      '-C',
      repo,
      'config',
      '--get',
      'core.hooksPath',
    ]).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(GitFailure);
  });
});
