import { z } from '@hono/zod-openapi';
import {
  canonicalizeProjectPath,
  projectKeyForCodebase,
  projectKeyForStorageRoot,
  resolveRunStorageRoot,
} from '@archon/paths';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { registerRepository } from '@archon/core/handlers/clone';
import { resolveCodebaseForPath } from '@archon/core/services/codebase-checkout-resolver';
import {
  stateProjectKeySchema,
  statePatchSchema,
  stateValueSchema,
  type stateWriteScopeSchema,
  StateRevisionConflictError,
  StateDocumentTooLargeError,
  StateLeaseHeldError,
  StatePatchError,
  type IStateDocumentStore,
  type StateLeaseChange,
  type StateScope,
  type StateWriter,
} from '@archon/workflows/state-document-store';
import { readCallingNode } from '../utils/calling-node';
import { writeJsonLine } from '../utils/stdout';
import {
  EXIT,
  parseStateArguments,
  readStdin,
  type ParsedStateArguments,
  type StateCommandOptions,
} from './state-arguments';

export type { StateCommandOptions };

export class StateProjectResolutionError extends Error {}
export class StateStoreMismatchError extends Error {}
/** `get --raw` on a document whose value is not a string. */
export class StateValueNotTextError extends Error {}
type StateHost = Pick<WorkflowHost, 'deps' | 'records'>;
type StateInput = z.infer<typeof stateWriteScopeSchema>;
type StateWriteInput = StateInput & { lease: StateLeaseChange | undefined };

function resolveRunWriter(runId: string, env: NodeJS.ProcessEnv): StateWriter {
  return { kind: 'run', ...readCallingNode(runId, env) };
}

async function resolveRunContext(
  store: StateHost['deps']['store'],
  runId: string,
  options: StateCommandOptions,
  env: NodeJS.ProcessEnv,
  storeKind: string | undefined
): Promise<{ projectKey: string | undefined; writer: StateWriter }> {
  let projectKey: string | undefined;
  // Inside a run a node reaches its own project or, explicitly, the install scope.
  if (options.project !== undefined)
    throw new Error('--project is only valid outside a run; a run writes to its own project');
  const run = await store.getWorkflowRun(runId);
  if (!run)
    throw new StateStoreMismatchError(
      `The CLI opened a different store than the engine: ${storeKind ?? 'database'} does not know WORKFLOW_ID ${env.WORKFLOW_ID}`
    );
  const codebase = run.codebase_id ? await store.getCodebase(run.codebase_id) : null;
  const resolved = resolveRunStorageRoot(run, codebase);
  if (resolved) projectKey = projectKeyForStorageRoot(resolved);
  else if (!options.install)
    throw new StateProjectResolutionError('The run has no resolvable project root');
  return { projectKey, writer: resolveRunWriter(run.id, env) };
}

async function resolveOperatorProjectKey(
  host: StateHost,
  options: StateCommandOptions
): Promise<string> {
  // Folder registration stores the canonical path (#2927), so look up the same
  // spelling: a symlinked or Windows 8.3 cwd would otherwise miss its project.
  const cwd = await canonicalizeProjectPath(options.cwd);
  let { codebase, repoRoot } = await resolveCodebaseForPath(cwd, host.records.codebases);
  if (repoRoot && !codebase) {
    const registered = await registerRepository(host.records.codebases, repoRoot);
    codebase = await host.records.codebases.getCodebase(registered.codebaseId);
    if (!codebase)
      throw new StateProjectResolutionError('Registered project is missing from the store');
  }
  return projectKeyForCodebase(codebase, repoRoot ?? cwd);
}

async function resolveStateContext(
  host: StateHost,
  options: StateCommandOptions,
  env: NodeJS.ProcessEnv,
  storeKind: string | undefined
): Promise<{ scope: StateScope; writer: StateWriter }> {
  let projectKey: string | undefined;
  let writer: StateWriter;
  if (env.WORKFLOW_ID) {
    ({ projectKey, writer } = await resolveRunContext(
      host.deps.store,
      env.WORKFLOW_ID,
      options,
      env,
      storeKind
    ));
  } else {
    if (env.ARCHON_NODE_EXECUTION) throw new Error('ARCHON_NODE_EXECUTION requires WORKFLOW_ID');
    if (options.project !== undefined) projectKey = stateProjectKeySchema.parse(options.project);
    else if (!options.install) projectKey = await resolveOperatorProjectKey(host, options);
    writer = { kind: 'surface', via: 'cli' };
  }
  const scope: StateScope = options.install
    ? { kind: 'install' }
    : { kind: 'project', key: stateProjectKeySchema.parse(projectKey) };
  return { scope, writer };
}

async function getStateDocument(store: IStateDocumentStore, scope: StateScope, name: string) {
  const row = await store.getStateDocument(scope, name);
  if (row) return { scope, name, revision: row.revision, value: row.value, lease: row.lease };
  // A deleted document's tombstone is the revision a recreating put must name.
  const [tombstone] = await store.listStateRevisions(scope, name, { limit: 1 });
  return tombstone
    ? { scope, name, revision: tombstone.revision, value: null, lease: null, deleted: true }
    : { scope, name, revision: 0, value: null, lease: null };
}

async function putStateDocument(
  store: IStateDocumentStore,
  input: StateWriteInput,
  ifRevision: number | undefined,
  raw: boolean | undefined,
  readInput: () => Promise<string>
) {
  const { scope, name } = input;
  if (ifRevision === undefined) throw new Error('put requires --if-revision');
  const source = await readInput();
  const value = raw ? source : stateValueSchema.parse(JSON.parse(source) as unknown);
  if (value === null) throw new StatePatchError(name, 0, 'Use delete for a tombstone');
  return { scope, ...(await store.putStateDocument({ ...input, value, ifRevision })) };
}

async function patchStateDocument(
  store: IStateDocumentStore,
  input: StateWriteInput,
  ifRevision: number | undefined,
  readInput: () => Promise<string>
) {
  const { scope, name } = input;
  const source = await readInput();
  let supplied: unknown;
  try {
    supplied = JSON.parse(source);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new StatePatchError(name, 0, 'Invalid JSON patch input');
  }
  const parsed = statePatchSchema.pick({ ops: true }).strict().safeParse(supplied);
  if (!parsed.success)
    throw new StatePatchError(
      name,
      0,
      'Invalid patch; expected {ops:[set|remove|append]} with JSON Pointer paths'
    );
  return {
    scope,
    ...(await store.patchStateDocument({
      ...input,
      ops: parsed.data.ops,
      ...(ifRevision !== undefined ? { ifRevision } : {}),
    })),
  };
}

async function executeStateCommand(
  store: IStateDocumentStore,
  input: StateInput,
  parsed: ParsedStateArguments,
  options: StateCommandOptions,
  readInput: () => Promise<string>
): Promise<object> {
  const { scope, name } = input;
  const { command, ifRevision, limit, prefix, lease } = parsed;
  switch (command) {
    case 'get':
      return getStateDocument(store, scope, name);
    case 'put':
      return putStateDocument(store, { ...input, lease }, ifRevision, options.raw, readInput);
    case 'patch':
      return patchStateDocument(store, { ...input, lease }, ifRevision, readInput);
    case 'delete':
      return {
        scope,
        ...(await store.deleteStateDocument({
          ...input,
          ...(ifRevision !== undefined ? { ifRevision } : {}),
        })),
      };
    case 'log':
      return {
        scope,
        name,
        revisions: await store.listStateRevisions(
          scope,
          name,
          limit === undefined ? {} : { limit }
        ),
      };
    case 'list': {
      const filter = prefix === undefined ? {} : { prefix };
      return {
        scope,
        documents: options.values
          ? (await store.getStateDocuments(scope, filter)).map(row => ({
              name: row.name,
              revision: row.revision,
              value: row.value,
              lease: row.lease,
            }))
          : await store.listStateDocuments(scope, filter),
      };
    }
  }
  throw new Error(`Unhandled state subcommand: ${command satisfies never}`);
}

function stateErrorCode(error: unknown): number {
  if (error instanceof StateRevisionConflictError || error instanceof StateLeaseHeldError)
    return EXIT.conflict;
  if (
    error instanceof StateDocumentTooLargeError ||
    error instanceof StatePatchError ||
    error instanceof StateValueNotTextError
  )
    return EXIT.invalid;
  if (error instanceof StateStoreMismatchError) return EXIT.storeMismatch;
  return EXIT.usage;
}

function stateErrorMessage(error: unknown): string {
  if (error instanceof z.ZodError) return 'Invalid state command arguments';
  if (error instanceof SyntaxError) return 'Invalid JSON input';
  return error instanceof Error ? error.message : String(error);
}

export async function stateCommand(
  host: StateHost,
  subcommand: string | undefined,
  args: string[],
  options: StateCommandOptions,
  dependencies: {
    env?: NodeJS.ProcessEnv;
    readInput?: () => Promise<string>;
    write?: typeof writeJsonLine;
    writeRaw?: (text: string) => Promise<void>;
    storeKind?: string;
  } = {}
): Promise<number> {
  const env = dependencies.env ?? process.env;
  const write = dependencies.write ?? writeJsonLine;
  const store = host.deps.store;
  const readInput = dependencies.readInput ?? readStdin;
  const writeRaw =
    dependencies.writeRaw ??
    (async (text: string): Promise<void> => {
      await new Promise<void>((resolve, reject) => {
        process.stdout.write(text, error => (error ? reject(error) : resolve()));
      });
    });
  try {
    const parsed = parseStateArguments(subcommand, args, options);
    const context = await resolveStateContext(host, options, env, dependencies.storeKind);
    const input = { ...context, name: parsed.name };
    if (parsed.lease !== undefined && context.writer.kind !== 'run')
      throw new Error('--lease and --release-lease are only valid inside a run');
    if (parsed.command === 'get' && options.raw) {
      const row = await store.getStateDocument(input.scope, input.name);
      if (typeof row?.value !== 'string')
        throw new StateValueNotTextError(`State document '${input.name}' has no text value`);
      await writeRaw(row.value);
    } else {
      await write(await executeStateCommand(store, input, parsed, options, readInput));
    }
    return 0;
  } catch (error) {
    const code = stateErrorCode(error);
    await write({ ok: false, error: stateErrorMessage(error), code });
    return code;
  }
}
