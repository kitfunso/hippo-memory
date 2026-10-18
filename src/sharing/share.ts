// Sharing local memories to the global store: transfer scoring, share, peers and auto-share.

import { BadRequestError, NotFoundError } from '../core/api-errors.js';
import * as fs from 'fs';
import * as path from 'path';
import { MemoryEntry, generateId, COMPACTION_MEMORY_TAG } from '../core/memory.js';
import { CLI_ACTOR } from '../core/actor.js';
import { AGENT_MEMORY_SOURCE_PREFIX, AGENT_MEMORY_TAGS } from '../core/agent-memory-tools.js';
import type { FolderStore, LocalFiles } from '../store/port.js';
import { isPersonalScope, isQuarantineScope } from '../core/recall-scope.js';
import { fallbackOrigin } from '../core/project-identity.js';
import { detectSecret } from '../util/secret-detect.js';
import { embedMemoryDetached, embedAll, folderIndex, type ConfiguredFolder } from '../search/embed-memories.js';
import { duplicateKey, longestWord, storedTextKeys } from '../util/same-text.js';
import { chunked } from '../util/chunked.js';
import { ALL_TENANTS, type TenantId } from '../util/tenant.js';
import { isReusable } from '../core/memory-quality.js';
import { log } from '../util/log.js';
import { logEmbedAllFailure } from './search-both.js';
import type { EntryCursor } from '../store/port/consolidation.js';
import type { EntrySignals, PageRequest, Sharing } from '../store/port/sharing.js';

/** Tags that indicate project-specific memories (poor transfer candidates) */
const PROJECT_SPECIFIC_TAGS = new Set([
  'file-path',
  'config',
  'deploy',
  'cron',
  'url',
  'auth',
  'field-names',
  'column-names',
  'api-key',
  'endpoint',
]);

/** Tags that indicate transferable memories (good transfer candidates) */
const TRANSFERABLE_TAGS = new Set([
  'error',
  'platform',
  'windows',
  'encoding',
  'python',
  'shell',
  'powershell',
  'quant',
  'backtest',
  'pattern',
  'rule',
  'gotcha',
  'sub-agent',
  'review',
  'best-practice',
]);

/** Tags whose rows only a hand-run share or promote may copy to the global store; derived rows inherit them. */
export const NEVER_AUTO_SHARE_TAGS: ReadonlySet<string> = new Set([
  'git-learned',
  'session-digest',
  ...AGENT_MEMORY_TAGS,
]);

export function neverAutoShareTags(sources: readonly MemoryEntry[]): string[] {
  return [...NEVER_AUTO_SHARE_TAGS].filter((tag) => sources.some((s) => s.tags.includes(tag)));
}

/** Tags whose rows sleep keeps as written: never merged, never
 * sent to LLM extraction. Conflict detection keeps its own list. */
export const NO_MERGE_TAGS: ReadonlySet<string> = new Set([
  'extracted',
  'session-digest',
  COMPACTION_MEMORY_TAG,
  ...AGENT_MEMORY_TAGS,
]);

/** The transfer score a memory needs before sleep or `hippo share --auto` copies it to the global store. */
export const AUTO_SHARE_MIN_SCORE = 0.6;

/** Below this transfer score a hand-run share copies a row only when forced. */
const SHARE_MIN_SCORE = 0.3;

/** transferScore's weights: where a row with no signal sits, then what each signal adds or takes away. */
const TRANSFER_WEIGHTS = {
  neutral: 0.5,
  perTransferableTag: 0.1,
  perProjectTag: 0.15,
  retrieved: 0.1,
  pinned: 0.1,
  negativeValence: 0.05,
} as const;

/** Recalls after which a memory counts as reused and earns TRANSFER_WEIGHTS.retrieved. */
const REUSED_AFTER_RETRIEVALS = 3;

/** Every trait that lifts transferScore above neutral or makes autoShare skip a row before scoring it. */
const AUTO_SHARE_SIGNALS: EntrySignals = {
  tags: [...TRANSFERABLE_TAGS, ...NEVER_AUTO_SHARE_TAGS],
  sourcePrefix: AGENT_MEMORY_SOURCE_PREFIX,
  minRetrievals: REUSED_AFTER_RETRIEVALS,
  valences: ['negative', 'critical'],
};

/** Rows autoShare reads, and shares, per page, so neither a read nor a write holds a whole tenant. */
const AUTO_SHARE_PAGE_ROWS = 500;

/** Estimate how well a memory would transfer to other projects.
 *  Returns 0..1 where >0.5 = good candidate for sharing. */
export function transferScore(entry: MemoryEntry): number {
  let score = TRANSFER_WEIGHTS.neutral;

  // Boost for transferable tags
  const transferableCount = entry.tags.filter((t) => TRANSFERABLE_TAGS.has(t)).length;
  score += transferableCount * TRANSFER_WEIGHTS.perTransferableTag;

  // Penalize for project-specific tags
  const specificCount = entry.tags.filter((t) => PROJECT_SPECIFIC_TAGS.has(t)).length;
  score -= specificCount * TRANSFER_WEIGHTS.perProjectTag;

  // High-retrieval memories are more likely to be universally useful
  if (entry.retrievalCount >= REUSED_AFTER_RETRIEVALS) score += TRANSFER_WEIGHTS.retrieved;

  // Pinned memories are important to their owner
  if (entry.pinned) score += TRANSFER_WEIGHTS.pinned;

  // Error-tagged memories often encode universal lessons
  if (entry.emotionalValence === 'negative' || entry.emotionalValence === 'critical') {
    score += TRANSFER_WEIGHTS.negativeValence;
  }

  return Math.min(1, Math.max(0, score));
}

/** Share a memory to the global store with attribution (source enriched with project path and timestamp).
 *  Returns the new entry, or null if the transfer score is too low. */
export async function shareMemory(
  local: FolderStore,
  global: ConfiguredFolder,
  id: string,
  options: { force?: boolean; tenantId: string; skipEmbed?: boolean },
): Promise<MemoryEntry | null> {
  // Tenant A cannot share tenant B's memory to global: the read finds no row of another tenant.
  const [entry] = await local.store.entriesByIds([id], options.tenantId);
  if (!entry) throw new NotFoundError(`Memory not found: ${id}`);

  const globalEntry = toGlobalEntry(local.root, entry, options.force === true);
  if (!globalEntry) return null;

  await global.store.entryWrites.writeEntry({ entry: globalEntry, actor: CLI_ACTOR });

  // Embed here unless the caller opts out: autoShare sets skipEmbed to batch one embedAll(), since embedMemory rewrites
  // the whole index per call.
  if (!options.skipEmbed) {
    const target = { hippoRoot: global.root, store: global.store, embeddings: global.config.embeddings };
    embedMemoryDetached(target, globalEntry);
  }

  return globalEntry;
}

/** The global copy of a local row, or null when its transfer score is too low and `force` is off; throws when the
 * row may not be shared. */
function toGlobalEntry(localRoot: string, entry: MemoryEntry, force: boolean): MemoryEntry | null {
  assertShareable(entry, entry.id);

  const score = transferScore(entry);
  if (score < SHARE_MIN_SCORE && !force) return null;

  // The label keeps the folder name for a user-global row; a NULL
  // row gets `shared::`, which originFromSource reads as no project.
  const fallbackName = path.basename(path.resolve(localRoot, '..'));
  const originName = entry.originProject ?? fallbackOrigin(localRoot);
  const label = originName === '' ? fallbackName : (originName ?? '');
  return {
    ...entry,
    id: generateId('g'),
    source: `shared:${label}:${new Date().toISOString()}`,
    originProject: originName,
  };
}

function assertShareable(entry: MemoryEntry, id: string): void {
  // Secret veto: secrets never reach the global store, even with --force; throw loudly, since a silent null reads as
  // "low transfer score" and invites retries.
  const secret = detectSecret(entry);
  if (secret.flagged) {
    throw new BadRequestError(
      `Refusing to share ${id} to the global store: content matches secret material (${secret.reason}). ` +
        `Secrets stay in their owning project's store.`,
    );
  }

  // A quarantined row is unreviewed input, not a lesson; sharing it would spread poison globally.
  if (isQuarantineScope(entry.scope)) {
    throw new BadRequestError(
      `Refusing to share ${id}: it is quarantined pending review. ` +
        `Approve it first via 'hippo quarantine approve ${id}'.`,
    );
  }
  if (isPersonalScope(entry.scope ?? null)) {
    throw new BadRequestError(
      `Refusing to share ${id}: it is a personal memory and stays with its owner on this server.`,
    );
  }
}

/** List all projects that contributed memories to the global store, parsed from 'shared:<project>:' or
 * 'promoted:<path>' sources; ALL_TENANTS is the host-wide view. */
export async function listPeers(
  global: FolderStore,
  tenantId: TenantId,
): Promise<Array<{ project: string; count: number; latest: string }>> {
  if (!fs.existsSync(global.root)) return [];

  const tallies = (await global.store.localFiles.sharing.sourceTallies(tenantId)).sort((a, b) =>
    a.first < b.first ? -1 : a.first > b.first ? 1 : 0,
  );
  const peerMap = new Map<string, { count: number; latest: string }>();

  for (const tally of tallies) {
    let project = 'unknown';

    if (tally.source.startsWith('shared:')) {
      const parts = tally.source.split(':');
      project = parts[1] || 'unknown';
    } else if (tally.source.startsWith('promoted:')) {
      const promotedPath = tally.source.slice('promoted:'.length);
      project = path.basename(path.resolve(promotedPath, '..'));
    } else if (tally.source === 'cli-global') {
      project = 'global-cli';
    }

    const existing = peerMap.get(project);
    if (!existing) {
      peerMap.set(project, { count: tally.count, latest: tally.latest });
    } else {
      existing.count += tally.count;
      if (tally.latest > existing.latest) existing.latest = tally.latest;
    }
  }

  return Array.from(peerMap.entries())
    .map(([project, data]) => ({ project, ...data }))
    .sort((a, b) => b.count - a.count);
}

type AutoShareStats = { secretSkipped: number; rejectedSkipped?: number; neverAutoShareSkipped?: number };

/** The rules a row must clear before autoShare asks the global store whether it already holds the text. */
function clearsShareRules(entry: MemoryEntry, minScore: number, stats: AutoShareStats | undefined): boolean {
  // shareMemory refuses quarantined and personal rows; filtering here keeps sleep from aborting on one.
  if (isQuarantineScope(entry.scope ?? null) || isPersonalScope(entry.scope ?? null) || !isReusable(entry)) {
    return false;
  }
  // Before the score: these rows describe one project only, and a git seed's 'error' tag clears the bar.
  if (entry.tags.some((t) => NEVER_AUTO_SHARE_TAGS.has(t)) || entry.source.startsWith(AGENT_MEMORY_SOURCE_PREFIX)) {
    if (stats) stats.neverAutoShareSkipped = (stats.neverAutoShareSkipped ?? 0) + 1;
    return false;
  }
  return transferScore(entry) >= minScore;
}

/** A row that cleared the rules shares unless the global store holds its text or it carries a secret. */
function isNewAndClean(
  entry: MemoryEntry,
  globalKeys: ReadonlySet<string>,
  stats: AutoShareStats | undefined,
): boolean {
  // Skip if already shared (same text apart from spacing)
  if (globalKeys.has(duplicateKey(entry.content))) return false;

  // Secret veto, checked LAST so the stats counter only counts rows it withheld (a row failing the score or dedupe gate
  // was never going to share).
  // shareMemory would throw here; filtering keeps the sleep pipeline fail-safe.
  if (detectSecret(entry).flagged) {
    if (stats) stats.secretSkipped++;
    return false;
  }

  return true;
}

/** The local rows a page at a time: above the neutral score only a row carrying a signal can share or count as a
 * never-auto-share skip, so only those are read. */
function* autoSharePages(sharing: Sharing, minScore: number, tenantId: TenantId): Generator<MemoryEntry[]> {
  let after: EntryCursor | null = null;
  do {
    const page: PageRequest = { limit: AUTO_SHARE_PAGE_ROWS, after: after ?? undefined };
    const { entries, next } =
      minScore > TRANSFER_WEIGHTS.neutral
        ? sharing.entriesWithSignals(AUTO_SHARE_SIGNALS, tenantId, page)
        : sharing.entriesPage(tenantId, page);
    yield entries;
    after = next;
  } while (after !== null);
}

/** The page's rows that share. Only a global row holding a row's longest word can hold its text, so the global store,
 * the union of every tenant, is asked for those rows alone. */
function pageCandidates(
  to: LocalFiles,
  page: readonly MemoryEntry[],
  minScore: number,
  stats: AutoShareStats | undefined,
): MemoryEntry[] {
  const scored = page.filter((entry) => clearsShareRules(entry, minScore, stats));
  if (scored.length === 0) return [];
  const words = scored.map((entry) => longestWord(entry.content)).filter((word) => word.length > 0);
  const globalKeys = storedTextKeys(to.captures.textsHolding(ALL_TENANTS, words, { everyScope: true }));
  return scored.filter((entry) => isNewAndClean(entry, globalKeys, stats));
}

/** Writes one page of candidates in one transaction; returns the copies written and how many a tombstone refused. */
function sharePage(localRoot: string, to: LocalFiles, page: readonly MemoryEntry[]) {
  const shared: MemoryEntry[] = [];
  let refused = 0;
  to.sharing.writeSkippingRejected((put) => {
    for (const entry of page) {
      const globalEntry = toGlobalEntry(localRoot, entry, true);
      if (!globalEntry) continue;
      if (put(globalEntry)) shared.push(globalEntry);
      else refused++;
    }
  });
  return { shared, refused };
}

// A row the GLOBAL store's rejection tombstones refuse is audited and skipped, so it cannot abort the autoShare sleep
// phase. The caller embeds once via embedAll() afterwards.
function shareCandidates(
  localRoot: string,
  to: LocalFiles,
  candidates: readonly MemoryEntry[],
  stats: AutoShareStats | undefined,
): MemoryEntry[] {
  const shared: MemoryEntry[] = [];
  let rejectedSkipped = 0;
  for (const page of chunked(candidates, AUTO_SHARE_PAGE_ROWS)) {
    const written = sharePage(localRoot, to, page);
    shared.push(...written.shared);
    rejectedSkipped += written.refused;
  }

  if (rejectedSkipped > 0) {
    if (stats) stats.rejectedSkipped = (stats.rejectedSkipped ?? 0) + rejectedSkipped;
    log.warn(`autoShare: skipped ${rejectedSkipped} candidate(s) refused by the global store's rejection tombstone`);
  }
  return shared;
}

/** Auto-share local memories with high transfer scores, not already global and without a NEVER_AUTO_SHARE_TAGS tag;
 * `options.tenantId` scopes the LOCAL read.
 * `options.stats` is an opt-in out-param: `secretSkipped` counts shares the secret veto prevented, `rejectedSkipped`
 * rejection refusals (0 under `dryRun`). */
export function autoShare(
  from: FolderStore,
  global: ConfiguredFolder,
  options: {
    minScore?: number;
    dryRun?: boolean;
    /** ALL_TENANTS for sleep, which shares every tenant's rows. */
    tenantId: TenantId;
    stats?: AutoShareStats;
  },
): MemoryEntry[] {
  const { minScore = AUTO_SHARE_MIN_SCORE, dryRun = false } = options;
  const to = global.store.localFiles;
  to.ensureFiles();
  // Every page is judged before any is written, so a copy written early cannot hide a later row's twin.
  const candidates: MemoryEntry[] = [];
  for (const page of autoSharePages(from.store.localFiles.sharing, minScore, options.tenantId)) {
    candidates.push(...pageCandidates(to, page, minScore, options.stats));
  }

  if (dryRun) return candidates;

  const shared = shareCandidates(from.root, to, candidates, options.stats);

  if (shared.length > 0) {
    void embedAll(folderIndex(global)).catch((err) => logEmbedAllFailure('autoShare', err));
  }

  return shared;
}
