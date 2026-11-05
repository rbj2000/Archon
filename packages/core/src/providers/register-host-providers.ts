import { BUNDLED_IS_BINARY, getPluginsPath, getSourceProviderEntry } from '@archon/paths';
import { isAgentIsolationEnabled, MAINTAINED_PROVIDER_IDS } from '@archon/provider-contract';
import { maintainedDescriptors, registerProvider } from '@archon/providers';
import { registerCopilotProvider } from '@archon/providers/community/copilot';
import { registerOpencodeProvider } from '@archon/providers/community/opencode';
import { getVendorCatalog } from '../credentials/catalog';
import { loadProviderPlugins } from './load-provider-plugins';
import { processProviderRegistration } from './process-registration';

/**
 * Release binaries carry no maintained-provider SDK: Claude, Codex and Pi come only
 * from install receipts. Source checkouts and Docker run all three from their plugin entries.
 */
export async function registerHostProviders(): Promise<void> {
  if (!BUNDLED_IS_BINARY) {
    for (const id of MAINTAINED_PROVIDER_IDS) {
      registerProvider(
        processProviderRegistration(
          maintainedDescriptors[id],
          [process.execPath, '--no-env-file', getSourceProviderEntry(id)],
          'source'
        )
      );
    }
  }
  // These two run inside the server, so they would execute agents as its user with its
  // credentials. Under isolation a workflow naming them fails as an unknown provider.
  if (!isAgentIsolationEnabled()) {
    registerOpencodeProvider();
    registerCopilotProvider();
  }
  for (const registration of await loadProviderPlugins(getPluginsPath(), {
    maintained: BUNDLED_IS_BINARY ? 'installed' : 'source',
  })) {
    registerProvider(registration);
  }
  getVendorCatalog();
}
