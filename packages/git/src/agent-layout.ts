/**
 * The permissions the agent boundary relies on. One function serves both the entrypoint, on every
 * start, and worktree creation, because a project registered after boot has no layout yet. Any
 * failure propagates: without this layout the boundary is not in force.
 */
import { chmod, chown, lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const SHARED_GROUP_GID = 1300;
/** Traverse only. The agent reaches known paths below, and cannot list or read these. */
const TRAVERSE = 0o710;
const SHARED_DIR = 0o2775;

/** Under `source/.git`, what `git commit` in a worktree must write. Never `config` or `hooks`. */
const GIT_SHARED = ['objects', 'refs', 'logs', 'worktrees', 'packed-refs', 'FETCH_HEAD'];

/** Children of a project directory. All others are closed to the agent. */
const PROJECT_SHARED = ['worktrees', 'artifacts', 'state'];
/** Owned by state exchange, which sets its own modes so one node's files are reachable. */
const PROJECT_LEFT_ALONE = ['state-exchange'];

export class UnsupportedAgentProjectError extends Error {
  override readonly name = 'UnsupportedAgentProjectError';
  constructor(source: string) {
    super(`${source} is not a plain clone, so agent isolation cannot protect its git config`);
  }
}

async function entries(path: string): Promise<string[]> {
  return (await readdir(path)).sort();
}

async function isRealDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function isOurs(entry: { uid: number }): boolean {
  return entry.uid === process.getuid?.();
}

async function setGroupAndMode(
  path: string,
  entry: { uid: number; gid: number; mode: number },
  mode: number
): Promise<void> {
  if (entry.gid !== SHARED_GROUP_GID) await chown(path, entry.uid, SHARED_GROUP_GID);
  if ((entry.mode & 0o7777) !== mode) await chmod(path, mode);
}

async function share(path: string, mode: number): Promise<void> {
  await setGroupAndMode(path, await lstat(path), mode);
}

/**
 * Without following symlinks: the agent may have planted them, and chmod would follow one. What the
 * agent owns is skipped, because the server cannot change it, and failing here would let one planted
 * file stop the server starting. Its own files are not the server's to protect.
 */
export async function shareTree(path: string): Promise<void> {
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || !isOurs(entry)) return;
  if (entry.isDirectory()) {
    await setGroupAndMode(path, entry, (entry.mode & 0o777) | 0o2770);
    for (const name of await entries(path)) await shareTree(join(path, name));
  } else {
    await setGroupAndMode(path, entry, (entry.mode & 0o777) | 0o660);
  }
}

async function closeToOthers(path: string): Promise<void> {
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || !isOurs(entry)) return;
  await chmod(path, entry.mode & 0o7770);
}

/** `.git` stays out of the group's write: a writable `.git` lets the agent plant `commondir`. */
async function applySourceLayout(source: string): Promise<void> {
  const git = join(source, '.git');
  // A symlinked source is the operator's own checkout, whose modes are not ours to change.
  if (!(await isRealDirectory(source)) || !(await isRealDirectory(git))) {
    throw new UnsupportedAgentProjectError(source);
  }
  await share(source, TRAVERSE);
  await chmod(git, 0o755);
  for (const name of GIT_SHARED) {
    try {
      await shareTree(join(git, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

/** One project directory: `<home>/workspaces/<owner>/<repo>`. Safe to repeat. */
export async function applyProjectAgentLayout(projectRoot: string): Promise<void> {
  await share(projectRoot, TRAVERSE);
  for (const name of await entries(projectRoot)) {
    const path = join(projectRoot, name);
    if (name === 'source') await applySourceLayout(path);
    else if (PROJECT_SHARED.includes(name)) {
      await share(path, SHARED_DIR);
      // Existing trees, on the first start with isolation on.
      for (const child of await entries(path)) await shareTree(join(path, child));
    } else if (!PROJECT_LEFT_ALONE.includes(name)) await closeToOthers(path);
  }
}

/**
 * For worktree creation. The walk is skipped once a project has its layout, because creation is
 * frequent and the entrypoint repeats the full walk on every start.
 */
export async function ensureProjectAgentLayout(projectRoot: string): Promise<void> {
  const objects = await lstat(join(projectRoot, 'source', '.git', 'objects')).catch(() => null);
  if (objects?.gid === SHARED_GROUP_GID && (objects.mode & 0o2000) !== 0) return;
  await applyProjectAgentLayout(projectRoot);
}

/** The whole Archon home. The entrypoint calls this as the server user, after fixing ownership. */
export async function applyAgentLayout(home: string): Promise<void> {
  await share(home, TRAVERSE);
  for (const name of await entries(home)) {
    if (name !== 'workspaces' && name !== 'worktrees') await closeToOthers(join(home, name));
  }
  await share(join(home, 'worktrees'), SHARED_DIR);
  for (const child of await entries(join(home, 'worktrees'))) {
    await shareTree(join(home, 'worktrees', child));
  }
  const workspaces = join(home, 'workspaces');
  await share(workspaces, TRAVERSE);
  for (const owner of await entries(workspaces)) {
    const ownerDir = join(workspaces, owner);
    if (!(await isRealDirectory(ownerDir))) continue;
    await share(ownerDir, TRAVERSE);
    for (const repo of await entries(ownerDir)) {
      const projectRoot = join(ownerDir, repo);
      if (!(await isRealDirectory(projectRoot))) continue;
      try {
        await applyProjectAgentLayout(projectRoot);
      } catch (error) {
        // One local-path project must not stop the server. Worktree creation refuses it instead.
        if (!(error instanceof UnsupportedAgentProjectError)) throw error;
        console.warn(`[archon] ${error.message}; worktree creation for it will be refused`);
      }
    }
  }
}
