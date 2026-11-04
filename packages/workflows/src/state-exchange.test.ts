import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { createFileWorkflowStore } from './file-store/store';
import { StateRevisionConflictError, type StateWriter } from './state-document-store';
import {
  applyStateOutbox,
  prepareStateExchange,
  queueStateOperation,
  stateExchangeEnvironment,
  stateOutboxPath,
  stateSnapshotPath,
  stateSnapshotSchema,
} from './state-exchange';

const projectKey = 'owner/repo';
const scope = { kind: 'project', key: projectKey } as const;
const writer: StateWriter = { kind: 'run', runId: 'run-1', nodePath: 'node' };

describe('state exchange', () => {
  let root: string;
  let store: Awaited<ReturnType<typeof createFileWorkflowStore>>;
  let stateDir: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'state-exchange-'));
    stateDir = join(root, 'project', 'state');
    mkdirSync(stateDir, { recursive: true });
    store = await createFileWorkflowStore({ root: join(root, 'store') });
  });
  afterEach(() => removeTempTree(root));

  const prepare = (): Promise<string> =>
    prepareStateExchange({ store, projectKey, stateDir, runId: 'run-1', nodePath: 'node' });
  const apply = (exchangeDir: string): Promise<number> =>
    applyStateOutbox({ store, projectKey, exchangeDir, writer });

  test('a queued put, patch and delete land in order, under the run writer', async () => {
    const dir = await prepare();
    await queueStateOperation(dir, { op: 'put', name: 'a', value: { n: 1 }, ifRevision: 0 });
    await Bun.sleep(2);
    await queueStateOperation(dir, {
      op: 'patch',
      name: 'a',
      ops: [{ op: 'set', path: '/n', value: 2 }],
    });
    await Bun.sleep(2);
    await queueStateOperation(dir, { op: 'put', name: 'gone', value: 'x', ifRevision: 0 });
    await Bun.sleep(2);
    await queueStateOperation(dir, { op: 'delete', name: 'gone' });

    expect(await apply(dir)).toBe(4);
    const row = await store.getStateDocument(scope, 'a');
    expect(row?.value).toEqual({ n: 2 });
    expect(row?.writer).toEqual(writer);
    expect(await store.getStateDocument(scope, 'gone')).toBeNull();
  });

  test('the snapshot holds the project documents as they were', async () => {
    await store.putStateDocument({ scope, writer, name: 'a', value: 'one', ifRevision: 0 });
    const dir = await prepare();
    await store.putStateDocument({ scope, writer, name: 'a', value: 'two', ifRevision: 1 });
    const snapshot = stateSnapshotSchema.parse(
      JSON.parse(readFileSync(stateSnapshotPath(dir), 'utf8'))
    );
    expect(snapshot).toEqual({
      projectKey,
      documents: [{ name: 'a', revision: 1, value: 'one' }],
    });
  });

  test('a revision conflict fails, and keeps the earlier write', async () => {
    const dir = await prepare();
    await queueStateOperation(dir, { op: 'put', name: 'a', value: 1, ifRevision: 0 });
    await Bun.sleep(2);
    await queueStateOperation(dir, { op: 'put', name: 'b', value: 1, ifRevision: 7 });
    await expect(apply(dir)).rejects.toBeInstanceOf(StateRevisionConflictError);
    expect((await store.getStateDocument(scope, 'a'))?.value).toBe(1);
  });

  test('a retry starts empty, so a failed attempt leaves no writes behind', async () => {
    const dir = await prepare();
    await queueStateOperation(dir, { op: 'put', name: 'a', value: 1, ifRevision: 0 });
    expect(await prepare()).toBe(dir);
    expect(await apply(dir)).toBe(0);
    expect(await store.getStateDocument(scope, 'a')).toBeNull();
  });

  describe('entries written by untrusted code', () => {
    const valid = JSON.stringify({ op: 'put', name: 'first', value: 1, ifRevision: 0 });

    async function refuses(plant: (outbox: string) => void): Promise<void> {
      const dir = await prepare();
      const outbox = stateOutboxPath(dir);
      writeFileSync(join(outbox, '1-valid.json'), valid);
      plant(outbox);
      await expect(apply(dir)).rejects.toThrow('State outbox');
      // Nothing is applied when any entry is bad, including the good one before it.
      expect(await store.getStateDocument(scope, 'first')).toBeNull();
    }

    test('a symlink is not followed', async () => {
      const secret = join(root, 'secret.json');
      writeFileSync(secret, valid);
      await refuses(outbox => {
        symlinkSync(secret, join(outbox, '2-link.json'));
      });
    });
    test('a directory is refused', () =>
      refuses(outbox => {
        mkdirSync(join(outbox, '2-dir.json'));
      }));
    test('invalid JSON is refused', () =>
      refuses(outbox => {
        writeFileSync(join(outbox, '2-bad.json'), '{');
      }));
    test('an unknown operation is refused', () =>
      refuses(outbox => {
        writeFileSync(join(outbox, '2-bad.json'), JSON.stringify({ op: 'drop', name: 'a' }));
      }));
    test('an invalid name is refused', () =>
      refuses(outbox => {
        const entry = { op: 'put', name: 'NOT VALID', value: 1, ifRevision: 0 };
        writeFileSync(join(outbox, '2-bad.json'), JSON.stringify(entry));
      }));
    test('an oversized entry is refused', () =>
      refuses(outbox => {
        writeFileSync(join(outbox, '2-big.json'), ' '.repeat(1024 * 1024 + 1));
      }));
    test('too many entries are refused', () =>
      refuses(outbox => {
        for (let i = 0; i <= 1000; i++) writeFileSync(join(outbox, `3-${String(i)}.json`), valid);
      }));

    test('an entry cannot choose its scope or writer', async () => {
      const dir = await prepare();
      writeFileSync(
        join(stateOutboxPath(dir), '1.json'),
        JSON.stringify({
          op: 'put',
          name: 'a',
          value: 1,
          ifRevision: 0,
          scope: { kind: 'install' },
          writer: { kind: 'surface', via: 'cli' },
        })
      );
      await apply(dir);
      expect(await store.getStateDocument({ kind: 'install' }, 'a')).toBeNull();
      expect((await store.getStateDocument(scope, 'a'))?.writer).toEqual(writer);
    });

    test('an unfinished write is ignored', async () => {
      const dir = await prepare();
      writeFileSync(join(stateOutboxPath(dir), '.1.json'), '{');
      expect(await apply(dir)).toBe(0);
    });
  });

  test('only the outbox is group-writable', async () => {
    const dir = await prepare();
    expect(statSync(dir).mode & 0o7777).toBe(0o755);
    expect(statSync(stateSnapshotPath(dir)).mode & 0o777).toBe(0o644);
    expect(statSync(stateOutboxPath(dir)).mode & 0o7777).toBe(0o2770);
    expect(statSync(join(dir, '..')).mode & 0o777).toBe(0o711);
    expect(readdirSync(stateOutboxPath(dir))).toEqual([]);
    expect(existsSync(stateDir)).toBe(true);
  });

  describe('environment', () => {
    let saved: string | undefined;
    beforeEach(() => {
      saved = process.env.ARCHON_AGENT_USER;
    });
    afterEach(() => {
      if (saved === undefined) delete process.env.ARCHON_AGENT_USER;
      else process.env.ARCHON_AGENT_USER = saved;
    });

    test('is empty with isolation off', () => {
      delete process.env.ARCHON_AGENT_USER;
      expect(stateExchangeEnvironment(stateDir, { runId: 'r', path: 'p' })).toEqual({});
    });

    test('names the directory the attempt prepares', async () => {
      process.env.ARCHON_AGENT_USER = 'archon-agent';
      const dir = await prepare();
      expect(stateExchangeEnvironment(stateDir, { runId: 'run-1', path: 'node' })).toEqual({
        ARCHON_STATE_EXCHANGE: dir,
      });
    });
  });
});
