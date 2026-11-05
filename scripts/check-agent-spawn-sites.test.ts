import { describe, expect, test } from 'bun:test';
import { checkSpawnSites, findSpawnSite } from './check-agent-spawn-sites';

describe('findSpawnSite', () => {
  test.each([
    ['named import', "import { spawn } from 'child_process';"],
    ['aliased import', "import { spawn as go } from 'node:child_process'; go('x');"],
    ['namespace import', "import * as cp from 'node:child_process';"],
    ['dynamic import', "const cp = await import('child_process');"],
    ['Bun.spawn', "Bun.spawn(['x']);"],
    ['Bun.spawnSync', "Bun.spawnSync(['x']);"],
    ['the git package runner', "import { execFileAsync } from '@archon/git';"],
    ['aliased git runner', "import { execFileAsync as run } from '@archon/git'; run('x');"],
    ['namespaced git runner', "import * as git from '@archon/git'; git.execFileAsync('x');"],
  ])('finds %s', (_name, source) => {
    expect(findSpawnSite('x.ts', source)).toBe(true);
  });

  test.each([
    ['a comment', "// import { spawn } from 'child_process';"],
    ['a string', "const text = 'Bun.spawn(x)';"],
    ['another module', "import { spawn } from './local';"],
  ])('ignores %s', (_name, source) => {
    expect(findSpawnSite('x.ts', source)).toBe(false);
  });
});

describe('checkSpawnSites', () => {
  test('passes when the ledger matches', () => {
    expect(checkSpawnSites(['a.ts'], { 'a.ts': 'reason' })).toEqual([]);
  });
  test('fails on an unlisted site', () => {
    expect(checkSpawnSites(['a.ts'], {})[0]).toContain('a.ts can start a process');
  });
  test('fails on a stale entry', () => {
    expect(checkSpawnSites([], { 'a.ts': 'reason' })[0]).toContain('no longer starts');
  });
});
