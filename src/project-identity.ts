import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Project identity resolution for memory scope isolation (ROADMAP.md Part I
 * [Committed] "Memory scope isolation"; plan docs/plans/2026-07-01-memory-scope-isolation.md S1).
 *
 * Resolution rules:
 * - The nearest ancestor of cwd (including cwd itself) containing a `.hippo`
 *   directory is the project root; if none exists, the nearest ancestor
 *   containing `.git` (directory or worktree file).
 * - The user home directory is NEVER a project, even though it contains the
 *   global store at `~/.hippo`. Reaching home ends the walk.
 * - A directory with no marker anywhere up the walk is NOT a project: it
 *   resolves to the user-global identity (empty name), so memories written
 *   there stay injectable everywhere (matches pre-isolation behavior).
 *
 * NOTE: this module must stay free of imports from shared.ts / store.ts /
 * api.ts so any of them can import it without creating a cycle.
 */

/** The project a working directory belongs to. */
export interface ProjectIdentity {
  /** Realpath-resolved root directory of the project (the start dir when not in a project). */
  root: string;
  /** Lowercased basename of the project root; empty string when not in a project. */
  name: string;
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

/** Clear the per-process identity cache (test seam). */
export function clearProjectIdentityCache(): void {
  identityCache.clear();
}

/**
 * Canonicalize a path via realpath, falling back to path.resolve when the
 * path does not exist or realpath fails (mirrors importers.ts).
 */
function realpathOrResolve(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
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
  const stopDir = opts?.stopDir ? realpathOrResolve(opts.stopDir) : null;
  const start = realpathOrResolve(startInput);

  let hippoRoot: string | null = null;
  let gitRoot: string | null = null;
  let reachedHome = false;

  let dir = start;
  for (let depth = 0; depth < MAX_WALK_DEPTH; depth++) {
    if (samePath(dir, home)) {
      reachedHome = true;
      break;
    }
    if (stopDir !== null && samePath(dir, stopDir)) break;
    if (hippoRoot === null && fs.existsSync(path.join(dir, '.hippo'))) {
      hippoRoot = dir;
    }
    if (gitRoot === null && fs.existsSync(path.join(dir, '.git'))) {
      gitRoot = dir;
    }
    const parent = path.dirname(dir);
    if (samePath(parent, dir)) break; // filesystem root
    dir = parent;
  }

  let identity: ProjectIdentity;
  const root = hippoRoot ?? gitRoot;
  if (root !== null) {
    identity = { root, name: path.basename(root).toLowerCase(), isHome: false };
  } else if (reachedHome || isUnder(start, home)) {
    identity = { root: home, name: '', isHome: true };
  } else {
    // No markers anywhere: not a project. Empty name keeps these memories
    // user-global rather than fabricating an origin from a basename.
    identity = { root: start, name: '', isHome: false };
  }

  if (cacheable) identityCache.set(startInput, identity);
  return identity;
}

/**
 * The origin project to stamp on a memory written from cwd.
 * Returns the project name, or '' for user-global (written at/under home or
 * in a markerless directory) - injectable everywhere. Write sites must always
 * persist this value; a NULL origin_project column is reserved for legacy
 * pre-migration rows, which ambient context treats as deny (see plan
 * docs/plans/2026-07-01-memory-scope-isolation.md "Origin model").
 */
export function deriveOriginProject(
  cwd?: string,
  opts?: ResolveProjectIdentityOpts,
): string {
  return resolveProjectIdentity(cwd, opts).name;
}
