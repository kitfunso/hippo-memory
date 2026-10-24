// Resolves a folder's project by walking the disk for its markers, and finds hippo's stores; the types and the matching
// rules live in src/base/scope/project-identity.ts. Each call walks: a root that walks often holds a Host (host.ts).
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProjectIdentity, ResolveProjectIdentityOpts } from '../base/scope/project-identity.js';
import { errorFields, errorMessage, log } from '../base/util/log.js';
import { ignoringCodes, PATH_UNREADABLE } from '../base/util/expected-errors.js';
import { namesProjectsByRemote } from './config-file.js';
import { originRemoteId, projectFileId, readGitFilePointer } from './project-remote.js';
import { realpathOrResolve } from './real-path.js';
import { hippoHomeDir } from './agent-homes.js';
import { HIPPO_DIR } from '../base/util/agent-homes.js';

const MAX_WALK_DEPTH = 64;

/** Whether the global store's config names projects by their origin remote. Only the global store's: a per-store
 * switch would stamp one checkout two ways. */
export type RemoteRule = () => boolean;

const globalRemoteRule: RemoteRule = () => namesProjectsByRemote(resolveGlobalRootDir());

/** The id a root names itself by plus every rung that resolves; only the root's own `.git` is read, so a store nested
 * in another checkout keeps its folder name. */
function namesAt(root: string, legacyName: string, remoteOn: RemoteRule): Pick<ProjectIdentity, 'name' | 'aliases'> {
  const fileId = projectFileId(root);
  const remoteId = originRemoteId(root);
  const name = fileId ?? (remoteOn() ? remoteId : null) ?? legacyName;
  const aliases = [...new Set([fileId, remoteId, legacyName])].filter((n): n is string => n !== null && n !== name);
  return aliases.length > 0 ? { name, aliases } : { name };
}

/** Compare two resolved paths, case-insensitively on Windows. */
function samePath(a: string, b: string): boolean {
  if (process.platform === 'win32') return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

function isUnder(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  const under = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  if (under) return true;
  if (process.platform === 'win32') {
    const relLower = path.relative(parent.toLowerCase(), child.toLowerCase());
    return relLower === '' || (!relLower.startsWith('..') && !path.isAbsolute(relLower));
  }
  return false;
}

/** A `.hippo` marker must be a DIRECTORY (a store), so a stray file named `.hippo` cannot make its parent a project;
 *  `.git` stays existsSync because worktrees use a `.git` FILE. */
function isDirectoryAt(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch (err) {
    // Most folders on the walk up hold no marker, so a failed stat is the normal answer.
    log.debug(`project identity: no marker at ${p}: ${errorMessage(err)}`, errorFields(err));
    return false;
  }
}

/** Resolves the project identity for a working directory (default process.cwd()), walking the disk on each call. */
export function resolveProjectIdentity(cwd?: string, opts?: ResolveProjectIdentityOpts): ProjectIdentity {
  return walkIdentity(path.resolve(cwd ?? process.cwd()), opts, globalRemoteRule).identity;
}

/** One walk's answer; `rooted` is false where no root made the remote rule count, so a cached answer outlives it. */
export interface IdentityWalk {
  readonly identity: ProjectIdentity;
  readonly rooted: boolean;
}

/** One walk from `start`. */
export function walkIdentity(
  start: string,
  opts: ResolveProjectIdentityOpts | undefined,
  remoteOn: RemoteRule,
): IdentityWalk {
  const home = realpathOrResolve(opts?.homeDir ?? os.homedir());
  const stops = [realpathOrResolve(os.tmpdir())];
  if (opts?.stopDir) stops.push(realpathOrResolve(opts.stopDir));
  const real = realpathOrResolve(start);
  const { hippoRoot, gitRoot, reachedHome } = walkProjectMarkers(real, home, stops);
  const root = hippoRoot ?? gitRoot;
  if (root !== null) {
    const legacyName =
      (hippoRoot === null ? linkedWorktreeRepoName(root, home) : null) ?? path.basename(root).toLowerCase();
    return { identity: { root, ...namesAt(root, legacyName, remoteOn), legacyName, isHome: false }, rooted: true };
  }
  if (reachedHome || isUnder(real, home)) {
    return { identity: { root: home, name: '', legacyName: '', isHome: true }, rooted: false };
  }
  // No markers anywhere: not a project. Empty name keeps these memories user-global rather than fabricating an origin
  // from a basename.
  return { identity: { root: real, name: '', legacyName: '', isHome: false }, rooted: false };
}

/** The repo name a linked worktree shares with its main checkout (`repo.git` or `repo/.bare` for a bare repo), so one
 * repo is one project; null for any other checkout. */
function linkedWorktreeRepoName(gitRoot: string, home: string): string | null {
  const marker = path.join(gitRoot, '.git');
  if (!fs.existsSync(marker) || isDirectoryAt(marker)) return null;
  // An unreadable link is still a checkout, named after its own folder.
  const dirs = ignoringCodes(PATH_UNREADABLE, () => readGitFilePointer(gitRoot, fs.readFileSync(marker, 'utf8')));
  if (dirs?.commonDir == null) return null; // no git dir, or a submodule's or a separate git dir's own checkout
  const common = realpathOrResolve(dirs.commonDir);
  const repo = ['.git', '.bare'].includes(path.basename(common)) ? path.dirname(common) : common;
  if (samePath(repo, home)) return null; // a dotfiles repo at home must not make its worktrees user-global
  return (
    path
      .basename(repo)
      .replace(/\.git$/i, '')
      .toLowerCase() || null
  );
}

interface MarkerWalk {
  hippoRoot: string | null;
  gitRoot: string | null;
  reachedHome: boolean;
}

/** Climb from start toward the root; home (never a project) and every stop dir end the walk unchecked. */
function walkProjectMarkers(start: string, home: string, stopDirs: readonly string[]): MarkerWalk {
  let hippoRoot: string | null = null;
  let gitRoot: string | null = null;
  let reachedHome = false;

  let dir = start;
  for (let depth = 0; depth < MAX_WALK_DEPTH; depth++) {
    if (samePath(dir, home)) {
      reachedHome = true;
      break;
    }
    if (stopDirs.some((stop) => samePath(dir, stop))) break;
    if (hippoRoot === null && isDirectoryAt(path.join(dir, HIPPO_DIR))) {
      hippoRoot = dir;
    }
    if (gitRoot === null && fs.existsSync(path.join(dir, '.git'))) {
      gitRoot = dir;
    }
    const parent = path.dirname(dir);
    if (samePath(parent, dir)) break; // filesystem root
    dir = parent;
  }
  return { hippoRoot, gitRoot, reachedHome };
}

/** Nearest ancestor `.hippo` below home and the temp root (never projects; on Windows the temp root sits inside home).
 *  Everything is realpath'd so a symlinked temp root or cwd still matches its bound. */
export function findHippoStoreDir(cwd?: string, opts?: ResolveProjectIdentityOpts): string | null {
  const home = realpathOrResolve(opts?.homeDir ?? os.homedir());
  const stops = [realpathOrResolve(os.tmpdir())];
  if (opts?.stopDir) stops.push(realpathOrResolve(opts.stopDir));
  const start = realpathOrResolve(cwd ?? process.cwd());
  const { hippoRoot } = walkProjectMarkers(start, home, stops);
  return hippoRoot === null ? null : path.join(hippoRoot, HIPPO_DIR);
}

/** Nearest ancestor store like git; the strict join is the fallback so `hippo init` still creates `<cwd>/.hippo`. */
export function getHippoRoot(cwd: string = process.cwd(), opts?: ResolveProjectIdentityOpts): string {
  return findHippoStoreDir(cwd, opts) ?? path.join(realpathOrResolve(cwd), HIPPO_DIR);
}

export function isInitialized(hippoRoot: string): boolean {
  // autoInstallHooks / setupDailySchedule can create a bare .hippo with no hippo.db; counting that as initialized makes
  // `hippo init` skip initStore, so only hippo.db counts.
  return fs.existsSync(path.join(hippoRoot, 'hippo.db'));
}

/** The global store's folder ($HIPPO_HOME > $XDG_DATA_HOME/hippo > ~/.hippo), which `getGlobalRoot` publishes. */
export function resolveGlobalRootDir(): string {
  return hippoHomeDir();
}

/** True when `p` IS the global store root, so a global store whose parent chain contains `.git`/`.hippo` (git-managed
 * HIPPO_HOME) still backfills as user-global ('') instead of being stamped with the surrounding repo's name, which
 * would hide the global corpus from every project. */
export function isGlobalStoreRoot(p: string): boolean {
  return samePath(realpathOrResolve(path.resolve(p)), realpathOrResolve(resolveGlobalRootDir()));
}

/** Parses a memory's origin from its provenance `source`: `shared:<project>:<ts>` and `promoted:<localRoot>` name the
 * owning project; the home dir basename maps to '' (user-global). Returns null without origin evidence. Pure string
 * logic, since recorded paths may no longer exist. */
export function originFromSource(source: string | null | undefined, homeName?: string): string | null {
  if (!source) return null;
  const home = (homeName ?? path.basename(os.homedir())).toLowerCase();
  const shared = /^shared:([^:]+):/.exec(source);
  if (shared) {
    const name = shared[1].toLowerCase();
    return name === home ? '' : name;
  }
  if (source.startsWith('promoted:')) {
    const promotedPath = source.slice('promoted:'.length).trim();
    if (!promotedPath) return null;
    const name = path.basename(path.resolve(promotedPath, '..')).toLowerCase();
    if (!name) return null;
    return name === home ? '' : name;
  }
  return null;
}

/** The origin to stamp on a memory written from cwd: its project name, or '' (user-global) outside a project. NULL,
 * which ambient context denies, is a shared store's or a legacy row's, never derived here. */
export function deriveOriginProject(cwd?: string, opts?: ResolveProjectIdentityOpts): string {
  return resolveProjectIdentity(cwd, opts).name;
}
