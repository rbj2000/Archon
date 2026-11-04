/**
 * How a node that runs as archon-agent uses `archon state` with no store access: it reads a
 * snapshot written before the attempt and queues writes in an outbox the server applies before the
 * node completes. A queued write is not a claim, so queues that claim through `--if-revision`
 * cannot work here.
 *
 * Everything in the outbox is written by untrusted code. The server opens each entry without
 * following links, bounds its size and validates it, and the scope and writer are never read from it.
 */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { chmod, chown, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { isAgentIsolationEnabled } from '@archon/provider-contract';
import {
  stateDeleteSchema,
  statePatchSchema,
  statePutSchema,
  type IStateDocumentStore,
  type StateRevision,
  type StateWriter,
} from './state-document-store';

export const STATE_EXCHANGE_ENV_KEY = 'ARCHON_STATE_EXCHANGE';
const SNAPSHOT_FILE = 'snapshot.json';
const OUTBOX_DIR = 'outbox';
const MAX_OUTBOX_ENTRIES = 1000;
const MAX_OUTBOX_ENTRY_BYTES = 1024 * 1024;

const stateOutboxOperationSchema = z.discriminatedUnion('op', [
  statePutSchema.pick({ name: true, value: true, ifRevision: true }).extend({
    op: z.literal('put'),
  }),
  statePatchSchema.pick({ name: true, ops: true, ifRevision: true }).extend({
    op: z.literal('patch'),
  }),
  stateDeleteSchema.pick({ name: true, ifRevision: true }).extend({
    op: z.literal('delete'),
  }),
]);
export type StateOutboxOperation = z.infer<typeof stateOutboxOperationSchema>;

export const stateSnapshotSchema = z.object({
  projectKey: z.string(),
  documents: z.array(z.object({ name: z.string(), revision: z.number(), value: z.unknown() })),
});
export type StateSnapshot = z.infer<typeof stateSnapshotSchema>;

export class StateOutboxError extends Error {
  override readonly name = 'StateOutboxError';
}

/** Derived from the run and node path, so the attempt and its environment cannot disagree. */
function stateExchangeDir(stateDir: string, runId: string, nodePath: string): string {
  const entry = createHash('sha256').update(`${runId}\0${nodePath}`).digest('hex').slice(0, 32);
  return join(dirname(stateDir), 'state-exchange', entry);
}

export function stateSnapshotPath(exchangeDir: string): string {
  return join(exchangeDir, SNAPSHOT_FILE);
}

export function stateOutboxPath(exchangeDir: string): string {
  return join(exchangeDir, OUTBOX_DIR);
}

/** The key is absent with isolation off, so that path's environment stays as it was. */
export function stateExchangeEnvironment(
  stateDir: string,
  execution: { runId: string; path: string } | null
): Record<string, string> {
  if (execution === null || !isAgentIsolationEnabled()) return {};
  return { [STATE_EXCHANGE_ENV_KEY]: stateExchangeDir(stateDir, execution.runId, execution.path) };
}

/**
 * Empties the exchange and writes the snapshot, so a retry never inherits a failed attempt's
 * writes. Only the outbox is group-writable: the agent cannot replace the snapshot or the outbox
 * itself. The group comes from `$STATE_DIR`, whose layout grants it to the agent.
 */
export async function prepareStateExchange(input: {
  store: Pick<IStateDocumentStore, 'getStateDocuments'>;
  projectKey: string;
  stateDir: string;
  runId: string;
  nodePath: string;
}): Promise<string> {
  const dir = stateExchangeDir(input.stateDir, input.runId, input.nodePath);
  const root = dirname(dir);
  await mkdir(root, { recursive: true });
  await chmod(root, 0o711);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { mode: 0o755 });

  const documents = await input.store.getStateDocuments({
    kind: 'project',
    key: input.projectKey,
  });
  const snapshot: StateSnapshot = {
    projectKey: input.projectKey,
    documents: documents.map(({ name, revision, value }) => ({ name, revision, value })),
  };
  await writeFile(stateSnapshotPath(dir), JSON.stringify(snapshot), { mode: 0o644 });

  const outbox = stateOutboxPath(dir);
  const { gid } = await stat(input.stateDir);
  await mkdir(outbox, { mode: 0o700 });
  await chown(outbox, process.getuid?.() ?? -1, gid);
  await chmod(outbox, 0o2770);
  return dir;
}

function readOutboxEntry(path: string, entry: string): StateOutboxOperation {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    throw new StateOutboxError(
      `State outbox entry '${entry}' cannot be opened: ${(error as NodeJS.ErrnoException).code}`
    );
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new StateOutboxError(`State outbox entry '${entry}' is not a file`);
    if (stats.size > MAX_OUTBOX_ENTRY_BYTES)
      throw new StateOutboxError(`State outbox entry '${entry}' is too large`);
    let supplied: unknown;
    try {
      supplied = JSON.parse(readFileSync(fd, 'utf8'));
    } catch {
      throw new StateOutboxError(`State outbox entry '${entry}' is not valid JSON`);
    }
    const parsed = stateOutboxOperationSchema.safeParse(supplied);
    if (!parsed.success) throw new StateOutboxError(`State outbox entry '${entry}' is invalid`);
    return parsed.data;
  } finally {
    closeSync(fd);
  }
}

function applyOperation(
  store: Pick<
    IStateDocumentStore,
    'putStateDocument' | 'patchStateDocument' | 'deleteStateDocument'
  >,
  base: { scope: { kind: 'project'; key: string }; writer: StateWriter },
  operation: StateOutboxOperation
): Promise<StateRevision> {
  const { name, ifRevision } = operation;
  const guard = ifRevision === undefined ? {} : { ifRevision };
  switch (operation.op) {
    case 'put':
      return store.putStateDocument({
        ...base,
        name,
        value: operation.value,
        ifRevision: operation.ifRevision,
      });
    case 'patch':
      return store.patchStateDocument({ ...base, name, ops: operation.ops, ...guard });
    case 'delete':
      return store.deleteStateDocument({ ...base, name, ...guard });
  }
}

/**
 * Applies the queued writes in name order, and throws on the first that fails. Every entry is
 * validated before any is applied, so only a store refusal such as a revision conflict can leave
 * earlier writes in place. Those stay: the store has no multi-document transaction.
 */
export async function applyStateOutbox(input: {
  store: Pick<
    IStateDocumentStore,
    'putStateDocument' | 'patchStateDocument' | 'deleteStateDocument'
  >;
  projectKey: string;
  exchangeDir: string;
  writer: StateWriter;
}): Promise<number> {
  const outbox = stateOutboxPath(input.exchangeDir);
  // Dotfiles are the CLI's unfinished writes; a process still running has not queued them yet.
  const entries = (await readdir(outbox)).filter(entry => !entry.startsWith('.')).sort();
  if (entries.length > MAX_OUTBOX_ENTRIES)
    throw new StateOutboxError(`State outbox holds more than ${String(MAX_OUTBOX_ENTRIES)} writes`);
  const operations = entries.map(entry => readOutboxEntry(join(outbox, entry), entry));
  const base = {
    scope: { kind: 'project', key: input.projectKey } as const,
    writer: input.writer,
  };
  for (const operation of operations) {
    await applyOperation(input.store, base, operation);
  }
  return operations.length;
}

/** The agent's side: rename makes an entry appear whole. The timestamp orders a node's writes. */
export async function queueStateOperation(
  exchangeDir: string,
  operation: StateOutboxOperation
): Promise<void> {
  const parsed = stateOutboxOperationSchema.safeParse(operation);
  if (!parsed.success) throw new StateOutboxError('Invalid state write');
  const outbox = stateOutboxPath(exchangeDir);
  const entry = `${String(Date.now()).padStart(15, '0')}-${randomUUID()}.json`;
  await writeFile(join(outbox, `.${entry}`), JSON.stringify(parsed.data));
  await rename(join(outbox, `.${entry}`), join(outbox, entry));
}

export async function removeStateExchange(exchangeDir: string): Promise<void> {
  await rm(exchangeDir, { recursive: true, force: true });
}
