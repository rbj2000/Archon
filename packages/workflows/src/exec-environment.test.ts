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
    const delivered = [
      ...EXEC_NODE_ENVIRONMENT_NAMES,
      ...Object.keys(
        // Only the key names matter, and the identity is only serialized into a value.
        buildAiNodeEnvironment({ runId: 'r', path: 'p' } as NodeExecutionIdentity, undefined)
      ),
    ].filter(name => name.startsWith('ARCHON_'));
    expect(new Set(delivered)).toEqual(new Set(AGENT_ARCHON_ENV_KEYS));
  });
});
