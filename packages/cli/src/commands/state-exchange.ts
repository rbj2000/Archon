/**
 * `archon state` for a node running as archon-agent. It has no store: reads come from the snapshot
 * taken before the attempt, and writes queue for the server. It must not import anything that opens
 * a database, since this user has no credentials for one.
 */
import { readFileSync } from 'node:fs';
import {
  StateOutboxError,
  queueStateOperation,
  stateSnapshotPath,
  stateSnapshotSchema,
  type StateOutboxOperation,
  type StateSnapshot,
} from '@archon/workflows/state-exchange';
import { statePatchSchema, statePutSchema } from '@archon/workflows/state-document-store';
import { writeJsonLine } from '../utils/stdout';
import {
  EXIT,
  parseStateArguments,
  readStdin,
  type ParsedStateArguments,
  type StateCommandOptions,
} from './state-arguments';

function readSnapshot(exchangeDir: string): StateSnapshot {
  try {
    return stateSnapshotSchema.parse(
      JSON.parse(readFileSync(stateSnapshotPath(exchangeDir), 'utf8'))
    );
  } catch {
    throw new Error(
      'archon state is not available in this node under agent isolation. ' +
        'Only agent, bash and script nodes of a registered project have it; loop iterations do not.'
    );
  }
}

async function parseWrite(
  parsed: ParsedStateArguments,
  options: StateCommandOptions
): Promise<StateOutboxOperation> {
  const { command, name, ifRevision } = parsed;
  if (command === 'delete') return { op: 'delete', name, ifRevision };
  if (command === 'patch') {
    const ops = statePatchSchema.shape.ops.parse(
      (JSON.parse(await readStdin()) as { ops?: unknown }).ops
    );
    return { op: 'patch', name, ops, ifRevision };
  }
  if (ifRevision === undefined) throw new Error('put requires --if-revision');
  const source = await readStdin();
  const value = options.raw
    ? source
    : statePutSchema.shape.value.parse(JSON.parse(source) as unknown);
  return { op: 'put', name, value, ifRevision };
}

async function runCommand(
  exchangeDir: string,
  parsed: ParsedStateArguments,
  options: StateCommandOptions
): Promise<void> {
  if (options.install || options.project !== undefined)
    throw new Error('Under agent isolation a node reaches only its own project');
  const { command, name, prefix } = parsed;
  if (command === 'log') throw new Error('state log is not available under agent isolation');
  // The outbox carries no lease change; dropping the flag would let two nodes believe they hold it.
  if (parsed.lease !== undefined)
    throw new Error('--lease and --release-lease are not available under agent isolation');
  const snapshot = readSnapshot(exchangeDir);
  const scope = { kind: 'project', key: snapshot.projectKey };

  if (command === 'get') {
    const row = snapshot.documents.find(document => document.name === name);
    if (options.raw) {
      if (typeof row?.value !== 'string')
        throw new Error(`State document '${name}' has no text value`);
      process.stdout.write(row.value);
      return;
    }
    // A deleted document reads as revision 0 here: the snapshot holds live documents only.
    await writeJsonLine({
      scope,
      name,
      revision: row?.revision ?? 0,
      value: row?.value ?? null,
    });
    return;
  }
  if (command === 'list') {
    const documents = snapshot.documents.filter(
      document => prefix === undefined || document.name.startsWith(prefix)
    );
    await writeJsonLine({
      scope,
      documents: options.values
        ? documents
        : documents.map(({ name: docName, revision }) => ({ name: docName, revision })),
    });
    return;
  }
  await queueStateOperation(exchangeDir, await parseWrite(parsed, options));
  // Reports no revision: the write has not happened, and the server may still refuse it.
  await writeJsonLine({ scope, name, queued: true });
}

export async function stateExchangeCommand(
  exchangeDir: string,
  subcommand: string | undefined,
  args: string[],
  options: StateCommandOptions
): Promise<number> {
  try {
    await runCommand(exchangeDir, parseStateArguments(subcommand, args, options), options);
    return 0;
  } catch (error) {
    const invalid = error instanceof StateOutboxError || error instanceof SyntaxError;
    const code = invalid ? EXIT.invalid : EXIT.usage;
    await writeJsonLine({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      code,
    });
    return code;
  }
}
