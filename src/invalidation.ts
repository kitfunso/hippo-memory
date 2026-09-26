import { loadAllEntries, readEntry, writeEntry } from './store.js';
import { openHippoDb, closeHippoDb } from './db.js';
import { CHURN_STALE_TAG, type MemoryEntry } from './memory.js';
import {
  GitReadError,
  gitLsFilesAtHead,
  fetchChurnWindowLog,
  gitGrepPresence,
  resolveCommitBefore,
  packageScriptsAt,
  type ChurnCommit,
} from './churn-git.js';

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

/**
 * Extract what was replaced/removed from a commit message.
 * Returns null if the commit isn't a breaking/migration change.
 */
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

/**
 * Find memories that reference the invalidated pattern and weaken them.
 * - Halves half_life_days
 * - Sets confidence to 'stale'
 * - Adds 'invalidated' tag
 * - Skips pinned memories (reported in skippedPinned)
 *
 * Tag matching is EXACT (2026-06-09 incident): the FULL pattern must equal a
 * tag. Token-level matching applies to content only, so a pattern that merely
 * CONTAINS a common tag word ("hippo") can no longer mass-weaken every memory
 * carrying that tag. Both callers (the CLI `invalidate` command and the
 * auto-learn-from-git path) inherit this contract.
 */
export function invalidateMatching(
  hippoRoot: string,
  target: InvalidationTarget,
  tenantId?: string,
  options?: InvalidationOptions,
): InvalidationResult {
  // L9: tenantId opt-in. When provided, only this tenant's memories are
  // considered for weakening. When undefined, behaves as it did pre-1.12.1
  // (host-wide invalidation across all tenants in the store).
  // options.onlyId resolves by FILTERING this tenant-scoped list — never a
  // direct id lookup — so an id from another tenant is invisible here.
  const entries = loadAllEntries(hippoRoot, tenantId);
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

  for (const entry of entries) {
    if (options?.onlyId !== undefined) {
      if (entry.id !== options.onlyId) continue;
    } else {
      const contentTokens = invalidationTokenize(entry.content);
      const tagTokens = entry.tags.map(t => t.toLowerCase());

      // Check if the memory references the old pattern
      const tokenMatch = matchScore(fromTokens, contentTokens);
      const tagMatch = tagTokens.includes(exactTag);

      if (!(tokenMatch >= 0.5 || tagMatch)) continue;
    }

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
      headline: entry.content.replace(/\s+/g, ' ').slice(0, 60),
    });
    if (dryRun) continue;

    entry.half_life_days = Math.max(1, Math.floor(entry.half_life_days / 2));
    entry.confidence = 'stale';
    if (!entry.tags.includes('invalidated')) {
      entry.tags.push('invalidated');
    }
    writeEntry(hippoRoot, entry);
  }

  return result;
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
  projectName: string;
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

// Anchor SQL runs on its own handle (closed in finally); queryAuditEvents is NOT
// reused here because its 10k-row cap would silently miss old confirmations.
function queryConfirmedAt(hippoRoot: string, tenantId: string): Map<string, string> {
  const db = openHippoDb(hippoRoot);
  try {
    // SAFETY: the SELECT list above is exactly target_id and ts; no other shape reaches this cast.
    const rows = db.prepare(
      `SELECT target_id, MAX(ts) AS ts FROM audit_log
       WHERE tenant_id = ? AND op = 'outcome' AND target_id IS NOT NULL
         AND json_extract(metadata_json, '$.good') = 1
       GROUP BY target_id`,
    ).all(tenantId) as { target_id: string; ts: string }[];
    return new Map(rows.map((r) => [r.target_id, r.ts]));
  } finally {
    closeHippoDb(db);
  }
}

function emptyChurnResult(dryRun: boolean, skippedPinned: string[] = [], error?: string): ChurnStaleResult {
  const result: ChurnStaleResult = { checked: 0, marked: 0, alreadyMarked: 0, skippedPinned, dryRun, preview: [] };
  if (error !== undefined) result.error = error;
  return result;
}

/** Flags memories whose named file/symbol/script changed or disappeared since storage (or last confirmation); only adds/removes CHURN_STALE_TAG, never confidence/half-life/strength. */
export function detectChurnStale(
  hippoRoot: string,
  repoRoot: string,
  opts: DetectChurnStaleOptions,
): ChurnStaleResult {
  const dryRun = opts.dryRun === true;
  if (!opts.projectName) return emptyChurnResult(dryRun);

  const entries = loadAllEntries(hippoRoot, opts.tenantId);
  const skippedPinned: string[] = [];
  const candidates: { entry: MemoryEntry; refs: ChurnRefs }[] = [];
  for (const entry of entries) {
    if (!entry.origin_project || entry.origin_project !== opts.projectName) continue;
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
  if (candidates.length === 0) return emptyChurnResult(dryRun, skippedPinned);

  const confirmedAt = queryConfirmedAt(hippoRoot, opts.tenantId);
  // Compared as epoch ms, not strings: imported rows may carry offsets or other ISO forms.
  const anchorOf = (entry: MemoryEntry): string => {
    const confirmed = confirmedAt.get(entry.id);
    const confirmedMs = confirmed ? Date.parse(confirmed) : NaN;
    return confirmedMs > Date.parse(entry.created) ? new Date(confirmedMs).toISOString() : new Date(entry.created).toISOString();
  };

  const needsPaths = candidates.some((c) => c.refs.paths.length > 0);
  const needsSymbols = candidates.some((c) => c.refs.symbols.length > 0);
  const needsScripts = candidates.some((c) => c.refs.scripts.length > 0);
  if (!needsPaths && !needsSymbols && !needsScripts) {
    return { checked: candidates.length, marked: 0, alreadyMarked: 0, skippedPinned, dryRun, preview: [] };
  }

  const result: ChurnStaleResult = { checked: 0, marked: 0, alreadyMarked: 0, skippedPinned, dryRun, preview: [] };

  try {
    const headFiles = gitLsFilesAtHead(repoRoot);
    let windowLog: ChurnCommit[] = [];
    if (needsPaths) {
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

    const presentAtHeadSymbols = needsSymbols
      ? gitGrepPresence(repoRoot, [...new Set(candidates.flatMap((c) => c.refs.symbols))], 'HEAD')
      : new Set<string>();

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

    const headScripts = needsScripts ? packageScriptsAt(repoRoot, 'HEAD') : null;
    const scriptsAtCommit = new Map<string, Record<string, string> | null>();

    // Collected here, written only after every candidate's evidence is
    // computed: a GitReadError thrown mid-loop must never leave an earlier
    // candidate tagged while a later one aborts the run untagged.
    const toTag: MemoryEntry[] = [];
    for (const { entry, refs } of candidates) {
      result.checked++;
      const anchor = anchorOf(entry);
      const anchorTime = new Date(anchor).getTime();
      let evidence: string | null = null;

      for (const rawPath of refs.paths) {
        const resolved = resolveTrackedPath(rawPath, repoRoot, opts.projectName, trackedIndex);
        if (!resolved) continue;
        if (isTrackedPath(headIndex, resolved)) {
          const changed = windowLog.some(
            (c) => new Date(c.date).getTime() > anchorTime && c.files.some((f) => f.path === resolved),
          );
          if (changed) { evidence = `file-changed: ${resolved}`; break; }
        } else {
          // --no-renames means a rename shows as a D + A pair, so this also fires for renames.
          const deleted = windowLog.some(
            (c) => new Date(c.date).getTime() > anchorTime &&
              c.files.some((f) => f.status === 'D' && f.path === resolved),
          );
          if (deleted) { evidence = `file-deleted: ${resolved}`; break; }
        }
      }

      if (!evidence && refs.symbols.length > 0) {
        const absent = refs.symbols.filter((s) => !presentAtHeadSymbols.has(s));
        if (absent.length > 0) {
          const anchorCommit = resolveAnchorCommit(anchor);
          if (anchorCommit) {
            const presentAtAnchor = symbolsPresentAt(anchorCommit, absent);
            const hit = absent.find((s) => presentAtAnchor.has(s));
            if (hit) evidence = `symbol-gone: \`${hit}\``;
          }
        }
      }

      if (!evidence && refs.scripts.length > 0 && headScripts !== null) {
        const anchorCommit = resolveAnchorCommit(anchor);
        if (anchorCommit) {
          if (!scriptsAtCommit.has(anchorCommit)) {
            scriptsAtCommit.set(anchorCommit, packageScriptsAt(repoRoot, anchorCommit));
          }
          const anchorScripts = scriptsAtCommit.get(anchorCommit);
          const hit = anchorScripts
            ? refs.scripts.find((s) => anchorScripts[s] !== undefined && headScripts[s] === undefined)
            : undefined;
          if (hit) evidence = `script-gone: ${hit}`;
        }
      }

      if (!evidence) continue;

      const headline = entry.content.replace(/\s+/g, ' ').slice(0, 60);
      if (entry.tags.includes(CHURN_STALE_TAG)) {
        result.alreadyMarked++;
        result.preview.push({ id: entry.id, headline, evidence, already: true });
        continue;
      }
      result.marked++;
      result.preview.push({ id: entry.id, headline, evidence, already: false });
      toTag.push(entry);
    }

    if (!dryRun) {
      for (const stale of toTag) {
        // Re-read: the git calls above can take seconds, and a recall or outcome may have written meanwhile.
        const entry = readEntry(hippoRoot, stale.id, opts.tenantId);
        if (!entry || entry.tags.includes(CHURN_STALE_TAG)) continue;
        writeEntry(hippoRoot, { ...entry, tags: [...entry.tags, CHURN_STALE_TAG] });
      }
    }
  } catch (err) {
    if (err instanceof GitReadError) return emptyChurnResult(dryRun, skippedPinned, err.message);
    throw err;
  }

  return result;
}
