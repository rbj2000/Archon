import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileInside } from './home-paths';
import { removeTempTree } from './test-utils';

describe('readFileInside', () => {
  let base: string;
  let root: string;
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'read-inside-')));
    root = join(base, 'root');
    mkdirSync(join(root, 'dir'), { recursive: true });
    writeFileSync(join(root, 'dir', 'a'), 'inside');
    mkdirSync(join(base, 'outside'));
    writeFileSync(join(base, 'outside', 'a'), 'secret');
  });
  afterEach(() => removeTempTree(base));

  test('reads a file inside the root', async () => {
    expect((await readFileInside(root, join(root, 'dir', 'a'))).toString()).toBe('inside');
  });

  test('refuses a leaf symlink', async () => {
    symlinkSync(join(base, 'outside', 'a'), join(root, 'link'));
    await expect(readFileInside(root, join(root, 'link'))).rejects.toMatchObject({ code: 'ELOOP' });
  });

  test('refuses a FIFO without hanging', async () => {
    execFileSync('mkfifo', [join(root, 'pipe')]);
    await expect(readFileInside(root, join(root, 'pipe'))).rejects.toMatchObject({
      code: 'EINVAL',
    });
  });

  // The swap a realpath check cannot see: this path was checked, then its parent became a link.
  test.skipIf(process.platform !== 'linux')('refuses a parent swapped for a symlink', async () => {
    renameSync(join(root, 'dir'), join(root, 'old'));
    symlinkSync(join(base, 'outside'), join(root, 'dir'));
    await expect(readFileInside(root, join(root, 'dir', 'a'))).rejects.toMatchObject({
      code: 'ELOOP',
    });
  });
});
