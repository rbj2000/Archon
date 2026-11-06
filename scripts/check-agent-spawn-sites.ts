/**
 * Every production file that can start a process must say which user that process runs as, so a new
 * spawn site (often from an upstream rebase) cannot silently run untrusted code as the server's user.
 * The unit is the file: importing the capability is what counts, so aliases and promisify cannot hide.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';

const REPO_ROOT = resolve(import.meta.dir, '..');

const WRAPPED = 'Goes through planAgentSpawn when isolation is on';
const INSIDE_PLUGIN = 'Runs inside a provider plugin process, which is already wrapped';
const GIT = 'Git through execFileAsync, which routes agent-writable locations to the agent user';
const OPERATOR = 'Operator-run command or operator-installed program, not workflow code';
const REFUSED = 'Refuses to execute node code when isolation is on';
const NOT_REGISTERED = 'Its provider is not registered when isolation is on';
const OWNER = 'Starts or inspects Archon processes owned by the server user';

/** The only list of these files. A stale entry fails, so it cannot outlive its reason. */
export const AGENT_SPAWN_LEDGER: Readonly<Record<string, string>> = {
  'packages/cli/src/commands/inspect-chat-plugin.ts': OPERATOR,
  'packages/cli/src/commands/isolation.ts': GIT,
  'packages/cli/src/commands/plugin-pack.ts': GIT,
  'packages/cli/src/commands/plugin-source.ts': GIT,
  'packages/cli/src/commands/serve.ts': OWNER,
  'packages/cli/src/commands/setup-github.ts': OPERATOR,
  'packages/cli/src/commands/setup-provider-auth.ts': OPERATOR,
  'packages/cli/src/commands/setup-spawn.ts': OPERATOR,
  'packages/cli/src/commands/trigger.ts': OWNER,
  'packages/cli/src/commands/version.ts': GIT,
  'packages/cli/src/commands/workflow-detach.ts': OWNER,
  'packages/cli/src/triggers/native-schedule.ts': OPERATOR,
  'packages/cli/src/utils/detached-resume-receipt.ts': OWNER,
  'packages/cli/src/utils/run-job-escape.ts': OWNER,
  'packages/core/src/github-auth/credential-helper-install.ts': OPERATOR,
  'packages/core/src/handlers/clone.ts': GIT,
  'packages/core/src/handlers/commands/status.ts': GIT,
  'packages/core/src/handlers/commands/worktree.ts': GIT,
  'packages/core/src/providers/inspect-provider-plugin.ts': OPERATOR,
  'packages/core/src/providers/process-provider.ts': WRAPPED,
  'packages/core/src/services/cleanup/run-lock.ts': GIT,
  'packages/core/src/services/registration-remote.ts': GIT,
  'packages/core/src/utils/github-graphql.ts': OPERATOR,
  'packages/core/src/workflows/branch-launch-source.ts': GIT,
  'packages/forge/src/credentials.ts': OPERATOR,
  'packages/forge/src/plugin-process.ts': OPERATOR,
  'packages/git/src/agent-git.ts': WRAPPED,
  'packages/git/src/branch.ts': GIT,
  'packages/git/src/exec.ts': GIT,
  'packages/git/src/registration-trust.ts': GIT,
  'packages/git/src/remote-branches.ts': GIT,
  'packages/git/src/repo.ts': GIT,
  'packages/git/src/worktree.ts': GIT,
  'packages/isolation/src/container/docker-exec.ts': OWNER,
  'packages/isolation/src/pr-state.ts': GIT,
  'packages/isolation/src/providers/worktree/branches.ts': GIT,
  'packages/isolation/src/providers/worktree/create.ts': GIT,
  'packages/isolation/src/providers/worktree/destroy.ts': GIT,
  'packages/isolation/src/providers/worktree/setup-lock.ts': GIT,
  'packages/paths/src/plugin-process.ts': OWNER,
  'packages/paths/src/windows-process-identity.ts': OWNER,
  'packages/providers/src/claude/container-spawn.ts': INSIDE_PLUGIN,
  'packages/providers/src/claude/native-auth.ts': INSIDE_PLUGIN,
  'packages/providers/src/claude/plugins.ts': INSIDE_PLUGIN,
  'packages/providers/src/claude/session-spend-reader.ts': INSIDE_PLUGIN,
  'packages/providers/src/codex/app-server.ts': INSIDE_PLUGIN,
  'packages/providers/src/community/copilot/binary-resolver.ts': NOT_REGISTERED,
  'packages/providers/src/community/opencode/runtime.ts': NOT_REGISTERED,
  'packages/providers/src/shared/binary-diagnostics.ts': INSIDE_PLUGIN,
  'packages/server/src/chat-host/supervisor.ts': OPERATOR,
  'packages/workflows/src/checkout-observation.ts': GIT,
  'packages/workflows/src/dag/checkout-guard.ts': GIT,
  'packages/workflows/src/detached-node-processes.ts': OWNER,
  'packages/workflows/src/dry-run/nodes/exec.ts': REFUSED,
  'packages/workflows/src/fixture-runner.ts': GIT,
  'packages/workflows/src/subprocess.ts': WRAPPED,
  'packages/workflows/src/validator/scripts.ts': OWNER,
};

export function findSpawnSite(path: string, source: string): boolean {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      /^(node:)?child_process$/.test(node.moduleSpecifier.text)
    )
      found = true;
    // @archon/git re-exports this, and it runs any program, not only git.
    if (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === 'execFileAsync')
      found = true;
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'execFileAsync') found = true;
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      /^(node:)?child_process$/.test(
        (node.arguments[0] as ts.StringLiteral | undefined)?.text ?? ''
      )
    )
      found = true;
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Bun' &&
      (node.name.text === 'spawn' || node.name.text === 'spawnSync')
    )
      found = true;
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function isProductionSource(path: string): boolean {
  return (
    /\.tsx?$/.test(path) &&
    !/\.(test|spec|type-test)\.tsx?$/.test(path) &&
    !/(^|\/)(__tests__|fixtures|test|scripts)\//.test(path) &&
    !/(test-utils|test-harness|test-support|test-fixtures|process-contract)/.test(path) &&
    !path.endsWith('vite.config.ts')
  );
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === 'node_modules' || entry.name === 'dist') return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : [path];
  });
}

export function checkSpawnSites(
  sites: readonly string[],
  ledger: Readonly<Record<string, string>>
): string[] {
  const known = new Set(sites);
  return [
    ...sites
      .filter(site => !(site in ledger))
      .map(site => `${site} can start a process and is not in AGENT_SPAWN_LEDGER`),
    ...Object.keys(ledger)
      .filter(site => !known.has(site))
      .map(site => `AGENT_SPAWN_LEDGER lists ${site}, which no longer starts a process`),
  ];
}

if (import.meta.main) {
  const packages = join(REPO_ROOT, 'packages');
  const sites = sourceFiles(packages)
    .map(path => relative(REPO_ROOT, path).split('\\').join('/'))
    .filter(isProductionSource)
    .filter(path => existsSync(join(REPO_ROOT, path)))
    .filter(path => findSpawnSite(path, readFileSync(join(REPO_ROOT, path), 'utf8')))
    .sort();
  if (process.argv[2] === '--list') {
    console.log(sites.join('\n'));
    process.exit(0);
  }
  const problems = checkSpawnSites(sites, AGENT_SPAWN_LEDGER);
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) process.exit(1);
  console.log('Agent spawn site check passed.');
}
