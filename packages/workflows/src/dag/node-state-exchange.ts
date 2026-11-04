/**
 * The engine side of the state exchange for one node attempt. See ../state-exchange.ts.
 */
import { projectKeyForStorageRoot, resolveRunStorageRoot } from '@archon/paths';
import { isAgentIsolationEnabled } from '@archon/provider-contract';
import type { AgentNode, ExecNode } from '../schemas';
import {
  applyStateOutbox,
  prepareStateExchange,
  removeStateExchange,
  STATE_EXCHANGE_ENV_KEY,
  stateExchangeEnvironment,
} from '../state-exchange';
import { getLog } from './log';
import type { RunLayersContext } from './run-context';

/** Undefined when the agent cannot use the exchange, so its `archon state` fails clearly. */
async function exchangeProjectKey(ctx: RunLayersContext): Promise<string | undefined> {
  if (ctx.execContext.kind !== 'host' || !isAgentIsolationEnabled()) return undefined;
  const { workflowRun: run, deps } = ctx;
  const codebase = run.codebase_id ? await deps.store.getCodebase(run.codebase_id) : null;
  const root = resolveRunStorageRoot(run, codebase);
  return root ? projectKeyForStorageRoot(root) : undefined;
}

/** Runs one attempt with a fresh exchange, removed afterwards whatever the attempt did. */
export async function withNodeStateExchange<T>(
  ctx: RunLayersContext,
  node: AgentNode | ExecNode,
  attempt: () => Promise<T>
): Promise<T> {
  const projectKey = await exchangeProjectKey(ctx);
  if (projectKey === undefined) return attempt();
  const dir = await prepareStateExchange({
    store: ctx.deps.store,
    projectKey,
    stateDir: ctx.stateDir,
    runId: ctx.workflowRun.id,
    nodePath: ctx.stepNamePrefix + node.id,
  });
  try {
    return await attempt();
  } finally {
    // A leftover is overwritten by the next attempt and cannot change an outcome already decided.
    await removeStateExchange(dir).catch((err: unknown) => {
      getLog().warn({ err: err as Error, dir }, 'workflow.state_exchange_remove_failed');
    });
  }
}

/**
 * Applies the attempt's queued writes. Callers run this before recording completion, so a refused
 * write fails the node instead of following a completed record. `failure` wraps the message in the
 * caller's own non-retried failure type: a retry would repeat writes that already landed.
 */
export async function applyNodeStateOutbox(
  ctx: RunLayersContext,
  node: AgentNode | ExecNode,
  failure: (message: string) => Error
): Promise<void> {
  const projectKey = await exchangeProjectKey(ctx);
  if (projectKey === undefined) return;
  const nodePath = ctx.stepNamePrefix + node.id;
  const exchangeDir = stateExchangeEnvironment(ctx.stateDir, {
    runId: ctx.workflowRun.id,
    path: nodePath,
  })[STATE_EXCHANGE_ENV_KEY];
  try {
    await applyStateOutbox({
      store: ctx.deps.store,
      projectKey,
      exchangeDir,
      writer: { kind: 'run', runId: ctx.workflowRun.id, nodePath },
    });
  } catch (error) {
    throw failure(`Node '${node.id}': ${(error as Error).message}`);
  }
}
