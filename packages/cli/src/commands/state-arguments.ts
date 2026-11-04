import { z } from '@hono/zod-openapi';
import {
  stateDocumentNameSchema,
  stateNamePrefixSchema,
  stateRevisionNumberSchema,
  type StateLeaseChange,
} from '@archon/workflows/state-document-store';

export interface StateCommandOptions {
  cwd: string;
  ifRevision?: string;
  limit?: string;
  prefix?: string;
  /** Workspace-relative project key (`owner/repo`); outside a run only. */
  project?: string;
  install?: boolean;
  raw?: boolean;
  values?: boolean;
  /** Inside a run: take the document's lease in this put or patch. */
  lease?: boolean;
  /** Inside a run: give the document's lease back in this put or patch. */
  releaseLease?: boolean;
}

// Scripts branch on these, never on message text.
export const EXIT = { usage: 1, conflict: 3, invalid: 4, storeMismatch: 5 } as const;
const commands = ['get', 'put', 'patch', 'log', 'delete', 'list'] as const;

// Windows CI: `Bun.stdin.text()` on a piped stdin stayed pending without holding the
// event loop open, so the CLI exited 0 having written nothing. The Node stream keeps
// the pipe handle alive until EOF.
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString('utf8');
}

type StateCommand = (typeof commands)[number];

function validateStateOptions(command: StateCommand, options: StateCommandOptions): void {
  if (options.ifRevision !== undefined && !['put', 'patch', 'delete'].includes(command))
    throw new Error('--if-revision is only valid for put, patch or delete');
  if (options.limit !== undefined && command !== 'log')
    throw new Error('--limit is only valid for log');
  if (options.prefix !== undefined && command !== 'list')
    throw new Error('--prefix is only valid for list');
  if (options.values && command !== 'list') throw new Error('--values is only valid for list');
  if (options.raw && !['get', 'put'].includes(command))
    throw new Error('--raw is only valid for get or put');
  if (options.install && options.project !== undefined)
    throw new Error('Use --install or --project, not both');
}

function parseLeaseChange(
  command: StateCommand,
  options: StateCommandOptions
): StateLeaseChange | undefined {
  if (!options.lease && !options.releaseLease) return undefined;
  if (command !== 'put' && command !== 'patch')
    throw new Error('--lease and --release-lease are only valid for put or patch');
  if (options.lease && options.releaseLease)
    throw new Error('Use --lease or --release-lease, not both');
  return options.lease ? 'take' : 'release';
}

function parseRevision(text: string): number {
  if (!/^(0|[1-9][0-9]*)$/u.test(text)) throw new Error('Expected a nonnegative integer');
  return stateRevisionNumberSchema.parse(Number(text));
}

export function parseStateArguments(
  subcommand: string | undefined,
  args: string[],
  options: StateCommandOptions
) {
  const command = commands.find(candidate => candidate === subcommand);
  if (!command) throw new Error(`Expected state ${commands.join('|')}`);
  if (args.length !== (command === 'list' ? 0 : 1))
    throw new Error(
      command === 'list' ? 'state list takes no document name' : 'Expected one document name'
    );
  validateStateOptions(command, options);
  const name = command === 'list' ? '' : stateDocumentNameSchema.parse(args[0]);
  const prefix =
    options.prefix === undefined ? undefined : stateNamePrefixSchema.parse(options.prefix);
  const ifRevision =
    options.ifRevision === undefined ? undefined : parseRevision(options.ifRevision);
  const lease = parseLeaseChange(command, options);

  const limit =
    options.limit === undefined
      ? undefined
      : z.number().int().positive().parse(parseRevision(options.limit));
  return { command, name, prefix, ifRevision, limit, lease };
}

export type ParsedStateArguments = ReturnType<typeof parseStateArguments>;
