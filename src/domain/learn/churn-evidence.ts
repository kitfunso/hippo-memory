// How a ref is judged changed: the refs a memory names, their tracked paths and the git evidence.
import type { MemoryEntry } from '../../base/memory/entry.js';
import {
  gitLsFilesAtHead,
  fetchChurnWindowLog,
  gitGrepPresence,
  resolveCommitBefore,
  packageScriptsAt,
  type ChurnCommit,
  type ChurnRepo,
} from './churn-git.js';
import type { ChurnCandidate } from './churn-stale.js';

// Opt-in, ROADMAP Part XIII.

const CHURN_PATH_EXTENSIONS = [
  'ts',
  'tsx',
  'js',
  'mjs',
  'cjs',
  'py',
  'md',
  'json',
  'sh',
  'ps1',
  'toml',
  'yml',
  'yaml',
  'sql',
  'rs',
  'go',
  'css',
  'html',
];
const CHURN_PATH_RE = new RegExp(
  // The lookahead stops `ts` winning over `tsx` and `js` over `json`.
  `[A-Za-z0-9_./\\\\:-]+\\.(?:${CHURN_PATH_EXTENSIONS.join('|')})(?![A-Za-z0-9_])(?::\\d+(?:-\\d+)?)?`,
  'g',
);
const CHURN_SYMBOL_RE = /`([A-Za-z_$][A-Za-z0-9_$]*)(?:\(\))?`/g;
const CHURN_SCRIPT_RE = /npm run(?:-script)?\s+([A-Za-z0-9:_-]+)/g;

export interface ChurnRefs {
  paths: string[];
  symbols: string[];
  scripts: string[];
}

/** Pure syntactic extraction; repo-aware resolution (trackedness, path relativization) happens
 * only in detectChurnStale. */
export function extractChurnRefs(content: string): ChurnRefs {
  const paths = new Set<string>();
  for (const m of content.matchAll(CHURN_PATH_RE)) {
    let token = m[0].replace(/:\d+(?:-\d+)?$/, '');
    token = token.replace(/\\/g, '/').replace(/^\.\//, '');
    if (token) paths.add(token);
  }

  const symbols = new Set<string>();
  for (const m of content.matchAll(CHURN_SYMBOL_RE)) {
    const name = m[1];
    // Plain words never count: require a camelCase/PascalCase transition or an inner underscore.
    if (name.length >= 6 && (/[a-z][A-Z]/.test(name) || /[A-Za-z0-9]_[A-Za-z0-9]/.test(name))) {
      symbols.add(name);
    }
  }

  const scripts = new Set<string>();
  for (const m of content.matchAll(CHURN_SCRIPT_RE)) scripts.add(m[1]);

  return { paths: [...paths], symbols: [...symbols], scripts: [...scripts] };
}

const IS_WIN32 = process.platform === 'win32';

interface TrackedIndex {
  exact: Set<string>;
  lower: Map<string, string>;
}

function buildTrackedIndex(paths: Set<string>): TrackedIndex {
  const lower = new Map<string, string>();
  for (const p of paths) lower.set(p.toLowerCase(), p);
  return { exact: paths, lower };
}

// Returns git's spelling so later exact matches against the log agree on case-insensitive Windows.
function trackedSpelling(index: TrackedIndex, candidate: string): string | null {
  if (index.exact.has(candidate)) return candidate;
  return IS_WIN32 ? (index.lower.get(candidate.toLowerCase()) ?? null) : null;
}

function isTrackedPath(index: TrackedIndex, candidate: string): boolean {
  return trackedSpelling(index, candidate) !== null;
}

// Absolute-path relativization and the <repoName>/ strip both need the repo, so they happen here
// rather than in the pure extractor.
function resolveTrackedPath(
  token: string,
  git: Pick<ChurnGitView, 'repoRoot' | 'projectName' | 'trackedIndex'>,
): string | null {
  const { repoRoot, projectName, trackedIndex: index } = git;
  let candidate = token;
  const isAbsUnix = candidate.startsWith('/');
  const isAbsWin = /^[A-Za-z]:\//.test(candidate);
  if (isAbsUnix || isAbsWin) {
    const rootPosix = repoRoot.replace(/\\/g, '/').replace(/\/$/, '');
    const prefix = `${rootPosix}/`;
    const under = IS_WIN32
      ? candidate.toLowerCase().startsWith(prefix.toLowerCase())
      : candidate.startsWith(prefix);
    if (!under) return null;
    candidate = candidate.slice(prefix.length);
  }
  const direct = trackedSpelling(index, candidate);
  if (direct) return direct;
  const repoPrefix = `${projectName}/`;
  if (candidate.toLowerCase().startsWith(repoPrefix.toLowerCase())) {
    return trackedSpelling(index, candidate.slice(repoPrefix.length));
  }
  return null;
}

/** Git facts every candidate's evidence check shares; per-commit lookups are cached so each runs
 * at most once. */
export interface ChurnGitView {
  repoRoot: string;
  projectName: string;
  windowLog: ChurnCommit[];
  trackedIndex: TrackedIndex;
  headIndex: TrackedIndex;
  presentAtHeadSymbols: Set<string>;
  headScripts: Record<string, string> | null;
  resolveAnchorCommit: (anchorIso: string) => string | null;
  symbolsPresentAt: (hash: string, symbols: string[]) => Set<string>;
  scriptsAt: (hash: string) => Record<string, string> | null | undefined;
}

export interface ChurnNeeds {
  paths: boolean;
  symbols: boolean;
  scripts: boolean;
}

/** The per-commit lookups of a ChurnGitView; each asks git once per commit and remembers the
 * answer. */
function churnCommitLookups(
  repo: ChurnRepo,
): Pick<ChurnGitView, 'resolveAnchorCommit' | 'symbolsPresentAt' | 'scriptsAt'> {
  const anchorCommitCache = new Map<string, string | null>();
  const resolveAnchorCommit = (anchorIso: string): string | null => {
    if (!anchorCommitCache.has(anchorIso)) {
      anchorCommitCache.set(anchorIso, resolveCommitBefore(repo, anchorIso));
    }
    return anchorCommitCache.get(anchorIso) ?? null;
  };

  const symbolsAtCommit = new Map<string, Set<string>>();
  const symbolsPresentAt = (hash: string, symbols: string[]): Set<string> => {
    const known = symbolsAtCommit.get(hash) ?? new Set<string>();
    const missing = symbols.filter((s) => !known.has(s));
    if (missing.length > 0) {
      for (const s of gitGrepPresence(repo, missing, hash)) known.add(s);
      symbolsAtCommit.set(hash, known);
    }
    return known;
  };

  const scriptsAtCommit = new Map<string, Record<string, string> | null>();
  const scriptsAt = (hash: string): Record<string, string> | null | undefined => {
    if (!scriptsAtCommit.has(hash)) {
      scriptsAtCommit.set(hash, packageScriptsAt(repo, hash));
    }
    return scriptsAtCommit.get(hash);
  };

  return { resolveAnchorCommit, symbolsPresentAt, scriptsAt };
}

interface LoadChurnGitViewOptions {
  readonly repo: ChurnRepo;
  readonly projectName: string;
  readonly candidates: readonly ChurnCandidate[];
  readonly anchorOf: (entry: MemoryEntry) => string;
  readonly needs: ChurnNeeds;
}

export function loadChurnGitView({
  repo,
  projectName,
  candidates,
  anchorOf,
  needs,
}: LoadChurnGitViewOptions): ChurnGitView {
  const headFiles = gitLsFilesAtHead(repo);
  let windowLog: ChurnCommit[] = [];
  if (needs.paths) {
    const minAnchor = candidates.reduce<string>((min, c) => {
      const a = anchorOf(c.entry);
      return min === '' || a < min ? a : min;
    }, '');
    windowLog = fetchChurnWindowLog(repo, minAnchor);
  }
  const touchedInWindow = new Set<string>();
  for (const c of windowLog) for (const f of c.files) touchedInWindow.add(f.path);
  const trackedIndex = buildTrackedIndex(new Set([...headFiles, ...touchedInWindow]));
  const headIndex = buildTrackedIndex(headFiles);

  const presentAtHeadSymbols = needs.symbols
    ? gitGrepPresence(repo, [...new Set(candidates.flatMap((c) => c.refs.symbols))], 'HEAD')
    : new Set<string>();
  const headScripts = needs.scripts ? packageScriptsAt(repo, 'HEAD') : null;

  return {
    repoRoot: repo.root,
    projectName,
    windowLog,
    trackedIndex,
    headIndex,
    presentAtHeadSymbols,
    headScripts,
    ...churnCommitLookups(repo),
  };
}

function pathEvidence(
  git: ChurnGitView,
  paths: readonly string[],
  anchorTime: number,
): string | null {
  for (const rawPath of paths) {
    const resolved = resolveTrackedPath(rawPath, git);
    if (!resolved) continue;
    if (isTrackedPath(git.headIndex, resolved)) {
      const changed = git.windowLog.some(
        (c) => new Date(c.date).getTime() > anchorTime && c.files.some((f) => f.path === resolved),
      );
      if (changed) return `file-changed: ${resolved}`;
    } else {
      // --no-renames means a rename shows as a D + A pair, so this also fires for renames.
      const deleted = git.windowLog.some(
        (c) =>
          new Date(c.date).getTime() > anchorTime &&
          c.files.some((f) => f.status === 'D' && f.path === resolved),
      );
      if (deleted) return `file-deleted: ${resolved}`;
    }
  }
  return null;
}

function symbolEvidence(
  git: ChurnGitView,
  symbols: readonly string[],
  anchor: string,
): string | null {
  const absent = symbols.filter((s) => !git.presentAtHeadSymbols.has(s));
  if (absent.length === 0) return null;
  const anchorCommit = git.resolveAnchorCommit(anchor);
  if (!anchorCommit) return null;
  const presentAtAnchor = git.symbolsPresentAt(anchorCommit, absent);
  const hit = absent.find((s) => presentAtAnchor.has(s));
  return hit ? `symbol-gone: \`${hit}\`` : null;
}

function scriptEvidence(
  git: ChurnGitView,
  scripts: readonly string[],
  anchor: string,
  headScripts: Record<string, string>,
): string | null {
  const anchorCommit = git.resolveAnchorCommit(anchor);
  if (!anchorCommit) return null;
  const anchorScripts = git.scriptsAt(anchorCommit);
  const hit = anchorScripts
    ? scripts.find((s) => anchorScripts[s] !== undefined && headScripts[s] === undefined)
    : undefined;
  return hit ? `script-gone: ${hit}` : null;
}

/**
 * The first churn evidence against one candidate: a changed or deleted file, then a gone symbol,
 * then a gone script.
 */
export function churnEvidence(git: ChurnGitView, refs: ChurnRefs, anchor: string): string | null {
  let evidence = pathEvidence(git, refs.paths, new Date(anchor).getTime());
  if (!evidence && refs.symbols.length > 0) evidence = symbolEvidence(git, refs.symbols, anchor);
  if (!evidence && refs.scripts.length > 0 && git.headScripts !== null) {
    evidence = scriptEvidence(git, refs.scripts, anchor, git.headScripts);
  }
  return evidence;
}
