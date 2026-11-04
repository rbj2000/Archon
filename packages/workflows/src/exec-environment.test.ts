import { describe, expect, test } from 'bun:test';
import { AGENT_ARCHON_ENV_KEYS } from '@archon/provider-contract';
import {
  buildAiNodeEnvironment,
  EXEC_NODE_ENVIRONMENT_NAMES,
  type NodeExecutionIdentity,
} from './exec-environment';

describe('agent isolation allowlist', () => {
  // A new engine-delivered ARCHON_* key would otherwise make every isolated node exit 125.
  test('covers every ARCHON_* key the engine delivers to a node', () => {
    const saved = process.env.ARCHON_AGENT_USER;
    process.env.ARCHON_AGENT_USER = 'archon-agent';
    const delivered = [
      ...EXEC_NODE_ENVIRONMENT_NAMES,
      ...Object.keys(
        // Only the key names matter, and the identity is only serialized into a value.
        buildAiNodeEnvironment(
          { runId: 'r', path: 'p' } as NodeExecutionIdentity,
          undefined,
          '/s/state'
        )
      ),
    ].filter(name => name.startsWith('ARCHON_'));
    if (saved === undefined) delete process.env.ARCHON_AGENT_USER;
    else process.env.ARCHON_AGENT_USER = saved;
    expect(new Set(delivered)).toEqual(new Set(AGENT_ARCHON_ENV_KEYS));
  });
});
