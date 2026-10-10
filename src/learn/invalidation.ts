import { addTagToEntries, writeEntriesSeparately } from '../store/entry-writes.js';
import { confirmedOutcomeTimes } from '../store/audit.js';
import { chunked, loadAllEntries, loadEntriesByIds } from '../store/entry-reads.js';
import { CHURN_STALE_TAG, type MemoryEntry } from '../core/memory.js';
import {
  GitReadError,
  gitLsFilesAtHead,
  fetchChurnWindowLog,
  gitGrepPresence,
  resolveCommitBefore,
  packageScriptsAt,
  type ChurnCommit,
} from './churn-git.js';

const HEADLINE_CHARS = 60;

export interface InvalidationTarget {
  from: string;
  to: string | null;
  type: 'migration' | 'removal' | 'deprecation';
}

export interface InvalidationResult {
  invalidated: number;
  targets: string[];  // IDs of affected memories
  skippedPinned: string[];  // matched but pinned — never touched
  dryRun: boolean;
  preview: { id: string; headline: string }[];  // what was (or would be) hit
}

export interface InvalidationOptions {
  /** Evaluate matches but write nothing. */
  dryRun?: boolean;
  /** Consider ONLY this memory id (no content/tag matching). */
  onlyId?: string;
}

/** Extract what was replaced/removed from a commit message.
 *  Returns null if the commit isn't a breaking/migration change. */
export function extractInvalidationTarget(message: string): InvalidationTarget | null {
  // Strip conventional commit prefix (e.g., "feat(scope): ")
  const body = message.replace(/^[a-z]+(\([^)]*\))?:\s*/i, '').trim();

  // Pattern: "migrate/switch/move/convert/transition/upgrade from X to Y"
  const fromToMatch = body.match(
    /(?:migrat\w+|switch\w*|mov\w+|convert\w*|transition\w*|upgrad\w+)\s+(?:from\s+)?(.+?)\s+to\s+(.+)/i
  );
  if (fromToMatch) {
    return { from: fromToMatch[1].trim(), to: fromToMatch[2].trim(), type: 'migration' };
  }

  // Pattern: "from X to Y" (standalone)
  const standaloneFromTo = body.match(/from\s+(.+?)\s+to\s+(.+)/i);
  if (standaloneFromTo) {
    return { from: standaloneFromTo[1].trim(), to: standaloneFromTo[2].trim(), type: 'migration' };
  }

  // Pattern: "replace X with Y"
  const replaceMatch = body.match(/replac\w+\s+(.+?)\s+with\s+(.+)/i);
  if (replaceMatch) {
    return { from: replaceMatch[1].trim(), to: replaceMatch[2].trim(), type: 'migration' };
  }

  // Pattern: "deprecate X"
  const deprecateMatch = body.match(/deprecat\w+\s+(.+)/i);
  if (deprecateMatch) {
    return { from: deprecateMatch[1].trim(), to: null, type: 'deprecation' };
  }

  // Pattern: "remove/drop X" (but not trivial removals)
  const removeMatch = body.match(/(?:remov\w+|drop\w*)\s+(.+)/i);
  if (removeMatch) {
    const target = removeMatch[1].trim();
    const words = target.split(/\s+/);
    const trivialWords = new Set(['extra', 'unused', 'empty', 'old', 'whitespace', 'spaces', 'blank', 'dead', 'commented']);
    const isTrivial = words.length <= 2 && words.some(w => trivialWords.has(w.toLowerCase()));
    if (isTrivial) return null;
    return { from: target, to: null, type: 'removal' };
  }

  return null;
}

/** Find memories that reference the invalidated pattern and weaken them (halve half_life_days, confidence 'stale', add 'invalidated' tag; pinned are skipped).
 *  Tag matching is EXACT: the FULL pattern must equal a tag, so a pattern merely containing a common tag word cannot mass-weaken every memory with that tag. */
export function invalidateMatching(
  hippoRoot: string,
  target: InvalidationTarget,
  tenantId?: string,
  options?: InvalidationOptions,
): InvalidationResult {
  // tenantId opt-in: when set, only that tenant's memories are weakened; undefined is host-wide.
  // options.onlyId filters this tenant-scoped list rather than looking up an id directly, so another tenant's id is invisible here.
  const { result, weakened } = weakenMatches(loadAllEntries(hippoRoot, tenantId), target, options);
  writeEntriesSeparately(hippoRoot, weakened);
  return result;
}

/** invalidateMatching for a batch: matches against `live`, the caller's list of the tenant's rows, and keeps it current.
 *  Each match is read again before it is weakened, so a row another writer changed since the list was read is never written back stale. */
export function invalidateMatchingAmong(
  hippoRoot: string,
  live: MemoryEntry[],
  target: InvalidationTarget,
  tenantId?: string,
): InvalidationResult {
  const seen = weakenMatches(live, target, { dryRun: true }).result;
  const ids = [...seen.targets, ...seen.skippedPinned];
  // loadEntriesByIds reads at most 500 ids a call.
  const fresh = new Map(chunked(ids, 500).flatMap((chunk) => loadEntriesByIds(hippoRoot, chunk, tenantId)).map((entry) => [entry.id, entry]));
  const { result, weakened } = weakenMatches(ids.flatMap((id) => fresh.get(id) ?? []), target);
  writeEntriesSeparately(hippoRoot, weakened);
  const byId = new Map(weakened.map((entry) => [entry.id, entry]));
  for (let i = 0; i < live.length; i++) live[i] = byId.get(live[i].id) ?? live[i];
  return result;
}

function referencesPattern(entry: MemoryEntry, fromTokens: string[], exactTag: string): boolean {
  const contentTokens = invalidationTokenize(entry.content);
  const tagTokens = entry.tags.map(t => t.toLowerCase());
  const tokenMatch = matchScore(fromTokens, contentTokens);
  const tagMatch = tagTokens.includes(exactTag);
  return tokenMatch >= 0.5 || tagMatch;
}

/** The match pass: weakens each unpinned match in place and returns them, writing nothing. */
function weakenMatches(entries: readonly MemoryEntry[], target: InvalidationTarget, options?: InvalidationOptions) {
  const fromTokens = invalidationTokenize(target.from);
  const exactTag = target.from.toLowerCase().trim();
  const dryRun = options?.dryRun === true;
  const result: InvalidationResult = {
    invalidated: 0,
    targets: [],
    skippedPinned: [],
    dryRun,
    preview: [],
  };
  const weakened: MemoryEntry[] = [];

  for (const entry of entries) {
    if (options?.onlyId !== undefined) {
      if (entry.id !== options.onlyId) continue;
    } else if (!referencesPattern(entry, fromTokens, exactTag)) continue;

    // Pinned check runs AFTER matching so pinned would-be targets are
    // observable in skippedPinned (pattern mode and onlyId mode alike).
    if (entry.pinned) {
      result.skippedPinned.push(entry.id);
      continue;
    }

    result.invalidated++;
    result.targets.push(entry.id);
    result.preview.push({
      id: entry.id,
      headline: entry.content.replace(/\s+/g, ' ').slice(0, HEADLINE_CHARS),
    });
    if (dryRun) continue;

    entry.half_life_days = Math.max(1, Math.floor(entry.half_life_days / 2));
    entry.confidence = 'stale';
    if (!entry.tags.includes('invalidated')) {
      entry.tags.push('invalidated');
    }
    weakened.push(entry);
  }

  return { result, weakened };
}

const STOPWORDS = new Set([
  'the', 'an', 'is', 'it', 'in', 'on', 'at', 'to', 'for', 'of', 'by',
  'and', 'or', 'but', 'not', 'with', 'from', 'that', 'this', 'was', 'are',
  'be', 'has', 'had', 'have', 'been', 'will', 'would', 'could', 'should',
  'do', 'does', 'did', 'all', 'our', 'old', 'new', 'use', 'used', 'using',
]);

function invalidationTokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s_.-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2 && !STOPWORDS.has(t));
}

function matchScore(fromTokens: string[], contentTokens: string[]): number {
  if (fromTokens.length === 0) return 0;
  const contentSet = new Set(contentTokens);
  const matches = fromTokens.filter(t => contentSet.has(t)).length;
  return matches / fromTokens.length;
}

// FE2: staleness from code churn (opt-in, ROADMAP Part XIII).

const CHURN_PATH_EXTENSIONS = [
  'ts', 'tsx', 'js', 'mjs', 'cjs', 'py', 'md', 'json', 'sh', 'ps1',
  'toml', 'yml', 'yaml', 'sql', 'rs', 'go', 'css', 'html',
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

/** Pure syntactic extraction; repo-aware resolution (trackedness, path relativization) happens only in detectChurnStale. */
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

export interface DetectChurnStaleOptions {
  tenantId: string;
  /** The project id; rows under it or legacyName are checked. */
  projectName: string;
  /** The folder name older rows carry, and the repo folder a memory's paths may start with. */
  legacyName?: string;
  /** Evaluate matches but write nothing. */
  dryRun?: boolean;
}

export interface ChurnStalePreviewRow {
  id: string;
  headline: string;
  evidence: string;
  already: boolean;
}

export interface ChurnStaleResult {
  checked: number;
  marked: number;
  alreadyMarked: number;
  skippedPinned: string[];
  dryRun: boolean;
  preview: ChurnStalePreviewRow[];
  error?: string;
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
  return IS_WIN32 ? index.lower.get(candidate.toLowerCase()) ?? null : null;
}

function isTrackedPath(index: TrackedIndex, candidate: string): boolean {
  return trackedSpelling(index, candidate) !== null;
}

// Absolute-path relativization and the <repoName>/ strip both need the repo, so they
// happen here rather than in the pure extractor.
function resolveTrackedPath(
  token: string,
  repoRoot: string,
  projectName: string,
  index: TrackedIndex,
): string | null {
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

function emptyChurnResult(dryRun: boolean, skippedPinned: string[] = [], error?: string): ChurnStaleResult {
  const result: ChurnStaleResult = { checked: 0, marked: 0, alreadyMarked: 0, skippedPinned, dryRun, preview: [] };
  if (error !== undefined) result.error = error;
  return result;
}

interface ChurnCandidate {
  entry: MemoryEntry;
  refs: ChurnRefs;
}

interface ChurnCandidates {
  candidates: ChurnCandidate[];
  skippedPinned: string[];
}

function collectChurnCandidates(entries: readonly MemoryEntry[], opts: Pick<DetectChurnStaleOptions, 'projectName' | 'legacyName'>): ChurnCandidates {
  const skippedPinned: string[] = [];
  const candidates: ChurnCandidate[] = [];
  for (const entry of entries) {
    if (!entry.origin_project || (entry.origin_project !== opts.projectName && entry.origin_project !== opts.legacyName)) continue;
    if (entry.superseded_by) continue;
    if (entry.kind === 'raw' || entry.kind === 'archived') continue;
    if (entry.pinned) {
      skippedPinned.push(entry.id);
      continue;
    }
    // An unparsable created has no anchor to compare commits against.
    if (Number.isNaN(Date.parse(entry.created))) continue;
    candidates.push({ entry, refs: extractChurnRefs(entry.content) });
  }
  return { candidates, skippedPinned };
}

/** Git facts every candidate's evidence check shares; per-commit lookups are cached so each runs at most once. */
interface ChurnGitView {
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

interface ChurnNeeds {
  paths: boolean;
  symbols: boolean;
  scripts: boolean;
}

/** The per-commit lookups of a ChurnGitView; each asks git once per commit and remembers the answer. */
function churnCommitLookups(repoRoot: string): Pick<ChurnGitView, 'resolveAnchorCommit' | 'symbolsPresentAt' | 'scriptsAt'> {
  const anchorCommitCache = new Map<string, string | null>();
  const resolveAnchorCommit = (anchorIso: string): string | null => {
    if (!anchorCommitCache.has(anchorIso)) {
      anchorCommitCache.set(anchorIso, resolveCommitBefore(repoRoot, anchorIso));
    }
    return anchorCommitCache.get(anchorIso) ?? null;
  };

  const symbolsAtCommit = new Map<string, Set<string>>();
  const symbolsPresentAt = (hash: string, symbols: string[]): Set<string> => {
    const known = symbolsAtCommit.get(hash) ?? new Set<string>();
    const missing = symbols.filter((s) => !known.has(s));
    if (missing.length > 0) {
      for (const s of gitGrepPresence(repoRoot, missing, hash)) known.add(s);
      symbolsAtCommit.set(hash, known);
    }
    return known;
  };

  const scriptsAtCommit = new Map<string, Record<string, string> | null>();
  const scriptsAt = (hash: string): Record<string, string> | null | undefined => {
    if (!scriptsAtCommit.has(hash)) {
      scriptsAtCommit.set(hash, packageScriptsAt(repoRoot, hash));
    }
    return scriptsAtCommit.get(hash);
  };

  return { resolveAnchorCommit, symbolsPresentAt, scriptsAt };
}

function loadChurnGitView(
  repoRoot: string,
  projectName: string,
  candidates: readonly ChurnCandidate[],
  anchorOf: (entry: MemoryEntry) => string,
  needs: ChurnNeeds,
): ChurnGitView {
  const headFiles = gitLsFilesAtHead(repoRoot);
  let windowLog: ChurnCommit[] = [];
  if (needs.paths) {
    const minAnchor = candidates.reduce<string>((min, c) => {
      const a = anchorOf(c.entry);
      return min === '' || a < min ? a : min;
    }, '');
    windowLog = fetchChurnWindowLog(repoRoot, minAnchor);
  }
  const touchedInWindow = new Set<string>();
  for (const c of windowLog) for (const f of c.files) touchedInWindow.add(f.path);
  const trackedIndex = buildTrackedIndex(new Set([...headFiles, ...touchedInWindow]));
  const headIndex = buildTrackedIndex(headFiles);

  const presentAtHeadSymbols = needs.symbols
    ? gitGrepPresence(repoRoot, [...new Set(candidates.flatMap((c) => c.refs.symbols))], 'HEAD')
    : new Set<string>();
  const headScripts = needs.scripts ? packageScriptsAt(repoRoot, 'HEAD') : null;

  return { repoRoot, projectName, windowLog, trackedIndex, headIndex, presentAtHeadSymbols, headScripts, ...churnCommitLookups(repoRoot) };
}

function pathEvidence(git: ChurnGitView, paths: readonly string[], anchorTime: number): string | null {
  for (const rawPath of paths) {
    const resolved = resolveTrackedPath(rawPath, git.repoRoot, git.projectName, git.trackedIndex);
    if (!resolved) continue;
    if (isTrackedPath(git.headIndex, resolved)) {
      const changed = git.windowLog.some(
        (c) => new Date(c.date).getTime() > anchorTime && c.files.some((f) => f.path === resolved),
      );
      if (changed) return `file-changed: ${resolved}`;
    } else {
      // --no-renames means a rename shows as a D + A pair, so this also fires for renames.
      const deleted = git.windowLog.some(
        (c) => new Date(c.date).getTime() > anchorTime &&
          c.files.some((f) => f.status === 'D' && f.path === resolved),
      );
      if (deleted) return `file-deleted: ${resolved}`;
    }
  }
  return null;
}

function symbolEvidence(git: ChurnGitView, symbols: readonly string[], anchor: string): string | null {
  const absent = symbols.filter((s) => !git.presentAtHeadSymbols.has(s));
  if (absent.length === 0) return null;
  const anchorCommit = git.resolveAnchorCommit(anchor);
  if (!anchorCommit) return null;
  const presentAtAnchor = git.symbolsPresentAt(anchorCommit, absent);
  const hit = absent.find((s) => presentAtAnchor.has(s));
  return hit ? `symbol-gone: \`${hit}\`` : null;
}

function scriptEvidence(git: ChurnGitView, scripts: readonly string[], anchor: string, headScripts: Record<string, string>): string | null {
  const anchorCommit = git.resolveAnchorCommit(anchor);
  if (!anchorCommit) return null;
  const anchorScripts = git.scriptsAt(anchorCommit);
  const hit = anchorScripts
    ? scripts.find((s) => anchorScripts[s] !== undefined && headScripts[s] === undefined)
    : undefined;
  return hit ? `script-gone: ${hit}` : null;
}

/** The first churn evidence against one candidate: a changed or deleted file, then a gone symbol, then a gone script. */
function churnEvidence(git: ChurnGitView, refs: ChurnRefs, anchor: string): string | null {
  let evidence = pathEvidence(git, refs.paths, new Date(anchor).getTime());
  if (!evidence && refs.symbols.length > 0) evidence = symbolEvidence(git, refs.symbols, anchor);
  if (!evidence && refs.scripts.length > 0 && git.headScripts !== null) {
    evidence = scriptEvidence(git, refs.scripts, anchor, git.headScripts);
  }
  return evidence;
}

function tagChurnStale(hippoRoot: string, tenantId: string, toTag: readonly MemoryEntry[], confirmedAt: Map<string, string>): void {
  // The git calls above can take seconds; a good outcome landing meanwhile moves the anchor past the evidence.
  const confirmedNow = confirmedOutcomeTimes(hippoRoot, tenantId);
  const unconfirmed = toTag.filter((stale) => confirmedNow.get(stale.id) === confirmedAt.get(stale.id));
  if (unconfirmed.length === 0) return;
  addTagToEntries(hippoRoot, tenantId, unconfirmed.map((stale) => stale.id), CHURN_STALE_TAG);
}

/** Counts every candidate's evidence into `result` and returns the rows still to tag, writing nothing. */
function recordChurnEvidence(
  git: ChurnGitView,
  candidates: readonly ChurnCandidate[],
  anchorOf: (entry: MemoryEntry) => string,
  result: ChurnStaleResult,
): MemoryEntry[] {
  const toTag: MemoryEntry[] = [];
  for (const { entry, refs } of candidates) {
    result.checked++;
    const evidence = churnEvidence(git, refs, anchorOf(entry));
    if (!evidence) continue;

    const headline = entry.content.replace(/\s+/g, ' ').slice(0, HEADLINE_CHARS);
    if (entry.tags.includes(CHURN_STALE_TAG)) {
      result.alreadyMarked++;
      result.preview.push({ id: entry.id, headline, evidence, already: true });
      continue;
    }
    result.marked++;
    result.preview.push({ id: entry.id, headline, evidence, already: false });
    toTag.push(entry);
  }
  return toTag;
}

/** Flags memories whose named file/symbol/script changed or disappeared since storage (or last
 * confirmation); only adds/removes CHURN_STALE_TAG, never confidence/half-life/strength. */
export function detectChurnStale(
  hippoRoot: string,
  repoRoot: string,
  opts: DetectChurnStaleOptions,
): ChurnStaleResult {
  const dryRun = opts.dryRun === true;
  if (!opts.projectName) return emptyChurnResult(dryRun);

  const entries = loadAllEntries(hippoRoot, opts.tenantId);
  const { candidates, skippedPinned } = collectChurnCandidates(entries, opts);
  if (candidates.length === 0) return emptyChurnResult(dryRun, skippedPinned);

  const confirmedAt = confirmedOutcomeTimes(hippoRoot, opts.tenantId);
  // Compared as epoch ms, not strings: imported rows may carry offsets or other ISO forms.
  const anchorOf = (entry: MemoryEntry): string => {
    const confirmed = confirmedAt.get(entry.id);
    const confirmedMs = confirmed ? Date.parse(confirmed) : NaN;
    return confirmedMs > Date.parse(entry.created) ? new Date(confirmedMs).toISOString() : new Date(entry.created).toISOString();
  };

  const needs: ChurnNeeds = {
    paths: candidates.some((c) => c.refs.paths.length > 0),
    symbols: candidates.some((c) => c.refs.symbols.length > 0),
    scripts: candidates.some((c) => c.refs.scripts.length > 0),
  };
  if (!needs.paths && !needs.symbols && !needs.scripts) {
    return { checked: candidates.length, marked: 0, alreadyMarked: 0, skippedPinned, dryRun, preview: [] };
  }

  const result: ChurnStaleResult = { checked: 0, marked: 0, alreadyMarked: 0, skippedPinned, dryRun, preview: [] };

  try {
    const git = loadChurnGitView(repoRoot, opts.legacyName ?? opts.projectName, candidates, anchorOf, needs);
    // Collected here and written only after every candidate's evidence is computed, so a GitReadError mid-loop cannot leave an earlier candidate tagged.
    const toTag = recordChurnEvidence(git, candidates, anchorOf, result);

    if (!dryRun && toTag.length > 0) tagChurnStale(hippoRoot, opts.tenantId, toTag, confirmedAt);
  } catch (err) {
    if (err instanceof GitReadError) return emptyChurnResult(dryRun, skippedPinned, err.message);
    throw err;
  }

  return result;
}
