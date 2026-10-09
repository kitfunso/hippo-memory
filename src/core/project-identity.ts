import { envHippoHome, envXdgDataHome } from '../util/env.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BadRequestError } from './api-errors.js';
import { isSharedStore, loadConfig } from './config.js';
import { MAX_ID_LEN } from '../util/http-util.js';
import { errorMessage, log } from '../util/log.js';
import { originRemoteId, projectFileId } from './project-remote.js';
import { realpathOrResolve } from '../util/real-path.js';

/**
 * Project identity resolution for memory scope isolation.
 *
 * Resolution rules:
 * - The nearest ancestor of cwd (including cwd itself) containing a `.hippo`
 *   directory is the project root; if none exists, the nearest ancestor
 *   containing `.git` (directory or worktree file).
 * - The user home directory is NEVER a project, even though it contains the
 *   global store at `~/.hippo`. Reaching home or the temp root (inside home on Windows) ends the walk.
 * - A directory with no marker anywhere up the walk is NOT a project: it
 *   resolves to the user-global identity (empty name), so memories written
 *   there stay injectable everywhere (matches pre-isolation behavior).
 * - A project's name is its id: `.hippo-project.json` at the root, else the
 *   checkout's normalised `origin` remote, else the folder rule (legacyName),
 *   so two repos in folders of one name stay apart.
 *
 * NOTE: this module must stay free of imports from shared.ts / store.ts /
 * api.ts so any of them can import it without creating a cycle.
 */

/** The project a working directory belongs to. */
export interface ProjectIdentity {
  /** Realpath-resolved root directory of the project (the start dir when not in a project). */
  root: string;
  /** The project id rows are stamped with: the project file's id, the origin remote, or legacyName; '' outside a project. */
  name: string;
  /** The folder rule rows written before ids carry: the root's lowercased basename, or its repo's for a linked worktree with no `.hippo`. */
  legacyName: string;
  /** Every other name this root resolves to (the project file id, the origin remote even with the rule off, legacyName), so rows written under an earlier id stay readable. */
  aliases?: readonly string[];
  /** True when the directory resolves to the user home working set. */
  isHome: boolean;
}

/**
 * Options for resolveProjectIdentity. Both fields are test seams; results are
 * not cached when either is set. stopDir bounds the upward walk so tests in a
 * temp sandbox never escape it and hit the host machine's real markers.
 */
export interface ResolveProjectIdentityOpts {
  homeDir?: string;
  stopDir?: string;
}

const MAX_WALK_DEPTH = 64;

const identityCache = new Map<string, ProjectIdentity>();

let remoteSwitch: { readonly globalRoot: string; readonly on: boolean } | null = null;

/** Clear the per-process identity cache and the remote switch it read (test seam). */
export function clearProjectIdentityCache(): void {
  identityCache.clear();
  remoteSwitch = null;
}

// The global store's config only: a per-store switch would stamp one checkout two ways.
function remoteRuleOn(): boolean {
  const globalRoot = resolveGlobalRootDir();
  if (remoteSwitch?.globalRoot !== globalRoot) remoteSwitch = { globalRoot, on: loadConfig(globalRoot).projectIdentity.remote };
  return remoteSwitch.on;
}

/** The id a root names itself by plus every rung that resolves; only the root's own `.git` is read, so a store nested in another checkout keeps its folder name. */
function namesAt(root: string, legacyName: string): Pick<ProjectIdentity, 'name' | 'aliases'> {
  const fileId = projectFileId(root);
  const remoteId = originRemoteId(root);
  const name = fileId ?? (remoteRuleOn() ? remoteId : null) ?? legacyName;
  const aliases = [...new Set([fileId, remoteId, legacyName])].filter((n): n is string => n !== null && n !== name);
  return aliases.length > 0 ? { name, aliases } : { name };
}

/** Compare two canonical paths, case-insensitively on Windows. */
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

/** A `.hippo` marker must be a DIRECTORY (a store) - a stray file named
 *  `.hippo` must not turn its parent into a project. `.git` stays existsSync
 *  because worktrees legitimately use a `.git` FILE. */
function isDirectoryAt(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch (err) {
    log.debug(`project identity: no marker at ${p}: ${errorMessage(err)}`);
    return false;
  }
}

/**
 * Resolve the project identity for a working directory.
 * Defaults to process.cwd(). Results are cached per resolved input path.
 */
export function resolveProjectIdentity(
  cwd?: string,
  opts?: ResolveProjectIdentityOpts,
): ProjectIdentity {
  const startInput = path.resolve(cwd ?? process.cwd());
  const cacheable = !opts?.homeDir && !opts?.stopDir;
  if (cacheable) {
    const cached = identityCache.get(startInput);
    if (cached) return cached;
  }

  const home = realpathOrResolve(opts?.homeDir ?? os.homedir());
  const stops = [realpathOrResolve(os.tmpdir())];
  if (opts?.stopDir) stops.push(realpathOrResolve(opts.stopDir));
  const start = realpathOrResolve(startInput);

  const { hippoRoot, gitRoot, reachedHome } = walkProjectMarkers(start, home, stops);

  let identity: ProjectIdentity;
  const root = hippoRoot ?? gitRoot;
  if (root !== null) {
    const legacyName = (hippoRoot === null ? linkedWorktreeRepoName(root, home) : null) ?? path.basename(root).toLowerCase();
    identity = { root, ...namesAt(root, legacyName), legacyName, isHome: false };
  } else if (reachedHome || isUnder(start, home)) {
    identity = { root: home, name: '', legacyName: '', isHome: true };
  } else {
    // No markers anywhere: not a project. Empty name keeps these memories
    // user-global rather than fabricating an origin from a basename.
    identity = { root: start, name: '', legacyName: '', isHome: false };
  }

  if (cacheable) identityCache.set(startInput, identity);
  return identity;
}

/** The repo name a linked worktree shares with its main checkout (`repo.git` or `repo/.bare` for a bare repo), so one repo is one project; null for any other checkout. */
function linkedWorktreeRepoName(gitRoot: string, home: string): string | null {
  const marker = path.join(gitRoot, '.git');
  if (!fs.existsSync(marker) || isDirectoryAt(marker)) return null;
  try {
    const gitDir = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(marker, 'utf8'))?.[1]?.trim();
    if (!gitDir) return null;
    const linkDir = path.resolve(gitRoot, gitDir);
    const commondir = path.join(linkDir, 'commondir');
    if (!fs.existsSync(commondir)) return null; // a submodule's or a separate git dir's own checkout
    const common = realpathOrResolve(path.resolve(linkDir, fs.readFileSync(commondir, 'utf8').trim()));
    const repo = ['.git', '.bare'].includes(path.basename(common)) ? path.dirname(common) : common;
    if (samePath(repo, home)) return null; // a dotfiles repo at home must not make its worktrees user-global
    return path.basename(repo).replace(/\.git$/i, '').toLowerCase() || null;
  } catch {
    return null; // an unreadable link is still a checkout, named after its own folder
  }
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
    if (hippoRoot === null && isDirectoryAt(path.join(dir, '.hippo'))) {
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
  return hippoRoot === null ? null : path.join(hippoRoot, '.hippo');
}

/** A reader's project: a bare name, or an identity whose own rows may also carry its legacy folder name. */
export type ProjectRef = string | Pick<ProjectIdentity, 'name' | 'legacyName' | 'aliases'>;

function isBareName(project: ProjectRef): project is string {
  return typeof project === 'string';
}

/** The id a reader's new rows are stamped with; '' outside a project. */
export function projectId(project: ProjectRef): string {
  return isBareName(project) ? project : project.name;
}

/** Every origin_project value the reader's own rows carry: the id first, then each alias and the legacy name. */
export function projectNames(project: ProjectRef): readonly string[] {
  if (isBareName(project) || project.name === '') return [projectId(project)];
  return [...new Set([project.name, ...(project.aliases ?? []), project.legacyName])].filter((n) => n !== '');
}

// Each project name is matched against every candidate row, so the caller's list stays short.
export const MAX_PROJECT_ALIASES = 10;
export const MCP_PROJECT_SCOPED_HEADER = 'X-Hippo-Project-Scoped';

/** Refuses a caller's project that is blank (it would stamp user-global), past the caps, or unlike the resolver's ids: rows match verbatim, so a rewrite would split a project. Inner spaces pass, since a checkout with no remote is named by its folder. */
export function assertCallerProject(project: { readonly name: string; readonly aliases?: readonly string[] }): void {
  const { name, aliases = [] } = project;
  if (name.trim() === '') throw new BadRequestError('project name must not be blank');
  if (aliases.length > MAX_PROJECT_ALIASES) throw new BadRequestError(`project aliases: at most ${MAX_PROJECT_ALIASES}`);
  if ([name, ...aliases].some((n) => n.length > MAX_ID_LEN)) {
    throw new BadRequestError(`project names: at most ${MAX_ID_LEN} characters each`);
  }
  if ([name, ...aliases].some((n) => n !== n.trim().toLowerCase() || /[:\p{Cc}]/u.test(n))) {
    throw new BadRequestError('project names: lowercase, not padded, with no colon or control character');
  }
}

/** `origin_project IN (?, ...)` with one placeholder per name; an empty list matches nothing. */
export function originInSql(names: readonly string[], column = 'origin_project'): string {
  return names.length === 0 ? '0' : `${column} IN (${names.map(() => '?').join(', ')})`;
}

/**
 * v39 memory scope isolation: classify a memory's origin_project against the
 * active project. An empty current id means the session is not in a project
 * (home dir or markerless cwd) - everything is in scope there, matching
 * pre-isolation behavior. NULL/undefined origin means no known project (a legacy
 * row, or a shared-store write that named none) and is treated as cross-project
 * (deny by default) - the safe direction for a security partition.
 */
export function classifyOriginProject(
  origin: string | null | undefined,
  current: ProjectRef,
): 'project' | 'user-global' | 'cross-project' {
  if (projectId(current) === '') return 'project';
  if (origin === undefined || origin === null) return 'cross-project';
  if (origin === '') return 'user-global';
  return projectNames(current).includes(origin) ? 'project' : 'cross-project';
}

/**
 * The global Hippo store directory, resolved the same way shared.ts does:
 * $HIPPO_HOME > $XDG_DATA_HOME/hippo > ~/.hippo. Lives here (leaf module) so
 * db.ts migrations can use it without importing shared.ts (store.ts cycle);
 * shared.getGlobalRoot delegates to this.
 */
export function resolveGlobalRootDir(): string {
  const hippoHome = envHippoHome();
  if (hippoHome) return hippoHome;
  const xdgData = envXdgDataHome();
  if (xdgData) return path.join(xdgData, 'hippo');
  return path.join(os.homedir(), '.hippo');
}

/**
 * True when `p` IS the global store root. Used by the v39 migration so a
 * global store whose parent chain happens to contain `.git`/`.hippo`
 * (git-managed HIPPO_HOME, dotfiles setups) still backfills as user-global
 * ('') instead of being stamped with the surrounding repo's name - which
 * would hide the user's entire global corpus from every project.
 */
export function isGlobalStoreRoot(p: string): boolean {
  return samePath(realpathOrResolve(path.resolve(p)), realpathOrResolve(resolveGlobalRootDir()));
}

/**
 * Parse a memory's origin from its provenance `source` string, mirroring the
 * v39 migration's evidence rules: `shared:<project>:<ts>` and
 * `promoted:<localRoot>` identify the owning project; the user home dir's
 * basename maps to '' (user-global). Returns null when the source carries no
 * origin evidence. Pure string logic - recorded paths may no longer exist.
 */
export function originFromSource(
  source: string | null | undefined,
  homeName?: string,
): string | null {
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

/** The origin to stamp on a memory written from cwd: its project name, or '' (user-global, injectable everywhere) outside a project.
 *  NULL means no known project: a legacy row with no evidence, or a write to a shared store that named none; ambient context treats it as deny. */
export function deriveOriginProject(
  cwd?: string,
  opts?: ResolveProjectIdentityOpts,
): string {
  return resolveProjectIdentity(cwd, opts).name;
}

/** The origin for a write that names none: NULL on a shared store, whose folder is no caller's project, else the folder's project. */
export function fallbackOrigin(hippoRoot: string): string | null {
  return isSharedStore(hippoRoot) ? null : deriveOriginProject(path.dirname(path.resolve(hippoRoot)));
}
