// Which memories the churn pass checks and what it writes.
import type { Learning } from '../../base/records/learning.js';
import { MINUTE_MS } from '../../base/util/time.js';
import { CHURN_STALE_TAG, type MemoryEntry } from '../../base/memory/entry.js';
import { GitReadError, type ChurnRepo } from './churn-git.js';
import type { EntryCursor } from '../../base/ports/store/types.js';
import { READ_PAGE_ROWS, readPages } from '../../base/util/pages.js';
import { previewHeadline } from './invalidation.js';
import {
  type ChurnRefs,
  extractChurnRefs,
  type ChurnGitView,
  type ChurnNeeds,
  loadChurnGitView,
  churnEvidence,
} from './churn-evidence.js';
import type { HippoStore } from '../../base/ports/store.js';

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

function emptyChurnResult(
  dryRun: boolean,
  skippedPinned: string[] = [],
  error?: string,
): ChurnStaleResult {
  const result: ChurnStaleResult = {
    checked: 0,
    marked: 0,
    alreadyMarked: 0,
    skippedPinned,
    dryRun,
    preview: [],
  };
  if (error !== undefined) result.error = error;
  return result;
}

export interface ChurnCandidate {
  entry: MemoryEntry;
  refs: ChurnRefs;
}

interface ChurnCandidates {
  candidates: ChurnCandidate[];
  skippedPinned: string[];
}

function collectChurnCandidates(
  entries: readonly MemoryEntry[],
  opts: Pick<DetectChurnStaleOptions, 'projectName' | 'legacyName'>,
): ChurnCandidates {
  const skippedPinned: string[] = [];
  const candidates: ChurnCandidate[] = [];
  for (const entry of entries) {
    if (
      !entry.originProject ||
      (entry.originProject !== opts.projectName && entry.originProject !== opts.legacyName)
    ) {
      continue;
    }
    if (entry.supersededBy) continue;
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

/** An outcome row is stamped before it commits, so the recheck starts a little before the
 * first read. */
const CONFIRM_RECHECK_MARGIN_MS = MINUTE_MS;

interface TagChurnStaleOptions {
  readonly learning: Learning;
  readonly tenantId: string;
  readonly toTag: readonly MemoryEntry[];
  readonly confirmedAt: Map<string, string>;
  readonly firstReadAt: number;
}

async function tagChurnStale({
  learning,
  tenantId,
  toTag,
  confirmedAt,
  firstReadAt,
}: TagChurnStaleOptions): Promise<void> {
  // The git calls above can take seconds, and an outcome landing meanwhile moves the anchor past
  // the evidence; only outcomes since the first read can have landed, so the recheck reads those.
  const recheckSince = new Date(firstReadAt - CONFIRM_RECHECK_MARGIN_MS).toISOString();
  const confirmedSince = await learning.confirmedOutcomeTimes(tenantId, recheckSince);
  const unconfirmed = toTag.filter((stale) => {
    const seen = confirmedSince.get(stale.id);
    return seen === undefined || seen === confirmedAt.get(stale.id);
  });
  if (unconfirmed.length === 0) return;
  await learning.addTagToEntries(
    tenantId,
    unconfirmed.map((stale) => stale.id),
    CHURN_STALE_TAG,
  );
}

/** Counts every candidate's evidence into `result` and returns the rows still to tag,
 * writing nothing. */
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

    const headline = previewHeadline(entry);
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

/** The good-outcome times the candidates' anchors need, and the anchor of each: its last
 * confirmation, if that is later than its creation. */
async function readChurnAnchors(
  learning: Learning,
  tenantId: string,
  candidates: readonly ChurnCandidate[],
) {
  const firstReadAt = Date.now();
  // A confirmation older than the oldest candidate cannot move any anchor, so the read
  // starts there.
  const oldestCreated = candidates.reduce(
    (oldest, c) => Math.min(oldest, Date.parse(c.entry.created)),
    Infinity,
  );
  const confirmedAt = await learning.confirmedOutcomeTimes(
    tenantId,
    new Date(oldestCreated).toISOString(),
  );
  // Compared as epoch ms, not strings: imported rows may carry offsets or other ISO forms.
  const anchorOf = (entry: MemoryEntry): string => {
    const confirmed = confirmedAt.get(entry.id);
    const confirmedMs = confirmed ? Date.parse(confirmed) : NaN;
    return confirmedMs > Date.parse(entry.created)
      ? new Date(confirmedMs).toISOString()
      : new Date(entry.created).toISOString();
  };
  return { confirmedAt, firstReadAt, anchorOf };
}

async function readChurnCandidates(
  store: Pick<HippoStore, 'entriesWhere'>,
  opts: DetectChurnStaleOptions,
): Promise<ChurnCandidates> {
  const origins = [opts.projectName, opts.legacyName].filter((name): name is string => !!name);
  const current = {
    tenantId: opts.tenantId,
    origins,
    live: true,
    kinds: ['distilled', 'superseded'],
  } as const;
  const candidates: ChurnCandidate[] = [];
  const skippedPinned: string[] = [];
  // Page by page, so only the candidates stay held, never every row of the project.
  for await (const page of readPages((after?: EntryCursor) =>
    store.entriesWhere(current, { limit: READ_PAGE_ROWS, after }),
  )) {
    const found = collectChurnCandidates(page, opts);
    candidates.push(...found.candidates);
    skippedPinned.push(...found.skippedPinned);
  }
  return { candidates, skippedPinned };
}

function churnNeeds(candidates: readonly ChurnCandidate[]): ChurnNeeds {
  return {
    paths: candidates.some((c) => c.refs.paths.length > 0),
    symbols: candidates.some((c) => c.refs.symbols.length > 0),
    scripts: candidates.some((c) => c.refs.scripts.length > 0),
  };
}

/** Flags memories whose named file/symbol/script changed or disappeared since storage (or last
 * confirmation); only adds/removes CHURN_STALE_TAG, never confidence/half-life/strength. */
export async function detectChurnStale(
  store: HippoStore & { readonly hippoDb: { readonly learning: Learning } },
  repo: ChurnRepo,
  opts: DetectChurnStaleOptions,
): Promise<ChurnStaleResult> {
  const dryRun = opts.dryRun === true;
  if (!opts.projectName) return emptyChurnResult(dryRun);

  const { learning } = store.hippoDb;
  const { candidates, skippedPinned } = await readChurnCandidates(store, opts);
  if (candidates.length === 0) return emptyChurnResult(dryRun, skippedPinned);

  const anchors = await readChurnAnchors(learning, opts.tenantId, candidates);
  const { confirmedAt, firstReadAt, anchorOf } = anchors;

  const needs = churnNeeds(candidates);
  if (!needs.paths && !needs.symbols && !needs.scripts) {
    return { ...emptyChurnResult(dryRun, skippedPinned), checked: candidates.length };
  }

  const result = emptyChurnResult(dryRun, skippedPinned);

  try {
    const gitProject = opts.legacyName ?? opts.projectName;
    const git = loadChurnGitView({ repo, projectName: gitProject, candidates, anchorOf, needs });
    // Collected here and written only after every candidate's evidence is computed, so a
    // GitReadError mid-loop cannot leave an earlier candidate tagged.
    const toTag = recordChurnEvidence(git, candidates, anchorOf, result);

    if (!dryRun && toTag.length > 0) {
      await tagChurnStale({ learning, tenantId: opts.tenantId, toTag, confirmedAt, firstReadAt });
    }
  } catch (err) {
    if (err instanceof GitReadError) return emptyChurnResult(dryRun, skippedPinned, err.message);
    throw err;
  }

  return result;
}
