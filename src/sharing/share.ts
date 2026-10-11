// Sharing local memories to the global store: transfer scoring, share, peers and auto-share.

import { BadRequestError, NotFoundError } from '../core/api-errors.js';
import * as fs from 'fs';
import * as path from 'path';
import { MemoryEntry, generateId, COMPACTION_MEMORY_TAG } from '../core/memory.js';
import { AGENT_MEMORY_SOURCE_PREFIX, AGENT_MEMORY_TAGS } from '../core/agent-memory-tools.js';
import { writeEntry } from '../store/entry-writes.js';
import { loadAllEntries, readEntry } from '../store/entry-reads.js';
import { tallySources } from '../store/candidates.js';
import { isPersonalScope } from '../core/recall-scope.js';
import { fallbackOrigin } from '../core/project-identity.js';
import { detectSecret } from '../util/secret-detect.js';
import { isQuarantineScope } from '../trust/quarantine.js';
import { RejectedValueError } from '../core/api-errors.js';
import { embedMemory, embedAll } from '../store/embeddings/index.js';
import { duplicateKey, storedTextKeys } from '../util/same-text.js';
import { isReusable } from '../core/memory-quality.js';
import { log } from '../util/log.js';
import { getGlobalRoot, initGlobal } from './global-store.js';
import { logEmbedAllFailure } from './search-both.js';

/** Tags that indicate project-specific memories (poor transfer candidates) */
const PROJECT_SPECIFIC_TAGS = new Set([
  'file-path', 'config', 'deploy', 'cron', 'url', 'auth',
  'field-names', 'column-names', 'api-key', 'endpoint',
]);

/** Tags that indicate transferable memories (good transfer candidates) */
const TRANSFERABLE_TAGS = new Set([
  'error', 'platform', 'windows', 'encoding', 'python', 'shell',
  'powershell', 'quant', 'backtest', 'pattern', 'rule', 'gotcha',
  'sub-agent', 'review', 'best-practice',
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

/** Tags whose rows sleep keeps as written: never merged, never sent to LLM extraction. Conflict detection keeps its own list. */
export const NO_MERGE_TAGS: ReadonlySet<string> = new Set([
  'extracted',
  'session-digest',
  COMPACTION_MEMORY_TAG,
  ...AGENT_MEMORY_TAGS,
]);

/** Estimate how well a memory would transfer to other projects.
 *  Returns 0..1 where >0.5 = good candidate for sharing. */
export function transferScore(entry: MemoryEntry): number {
  let score = 0.5; // neutral default

  // Boost for transferable tags
  const transferableCount = entry.tags.filter((t) => TRANSFERABLE_TAGS.has(t)).length;
  score += transferableCount * 0.1;

  // Penalize for project-specific tags
  const specificCount = entry.tags.filter((t) => PROJECT_SPECIFIC_TAGS.has(t)).length;
  score -= specificCount * 0.15;

  // High-retrieval memories are more likely to be universally useful
  if (entry.retrieval_count >= 3) score += 0.1;

  // Pinned memories are important to their owner
  if (entry.pinned) score += 0.1;

  // Error-tagged memories often encode universal lessons
  if (entry.emotional_valence === 'negative' || entry.emotional_valence === 'critical') score += 0.05;

  return Math.min(1, Math.max(0, score));
}

/** Share a memory to the global store with attribution (source enriched with project path and timestamp).
 *  Returns the new entry, or null if the transfer score is too low. */
export function shareMemory(
  localRoot: string,
  id: string,
  options: { force?: boolean; tenantId?: string; skipEmbed?: boolean } = {}
): MemoryEntry | null {
  // tenantId is optional for single-tenant callers (autoShare passes only `{ force: true }`); MCP/REST hosts MUST pass it so tenant A cannot share
  // tenant B's memory to global (readEntry returns null on a cross-tenant lookup).
  const entry = readEntry(localRoot, id, options.tenantId);
  if (!entry) throw new NotFoundError(`Memory not found: ${id}`);

  assertShareable(entry, id);

  const score = transferScore(entry);
  if (score < 0.3 && !options.force) return null;

  initGlobal();
  const globalRoot = getGlobalRoot();

  // The label keeps the folder name for a user-global row; a NULL row gets `shared::`, which originFromSource reads as no project.
  const fallbackName = path.basename(path.resolve(localRoot, '..'));
  const originName = entry.origin_project ?? fallbackOrigin(localRoot);
  const label = originName === '' ? fallbackName : (originName ?? '');
  const globalEntry: MemoryEntry = {
    ...entry,
    id: generateId('g'),
    source: `shared:${label}:${new Date().toISOString()}`,
    origin_project: originName,
  };

  writeEntry(globalRoot, globalEntry);

  // Embed here unless the caller opts out: autoShare sets skipEmbed to batch one embedAll(), since embedMemory rewrites the whole index per call.
  if (!options.skipEmbed) {
    void embedMemory(globalRoot, globalEntry);
  }

  return globalEntry;
}

function assertShareable(entry: MemoryEntry, id: string): void {
  // Secret veto: secrets never reach the global store, even with --force; throw loudly, since a silent null reads as "low transfer score" and invites retries.
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
      `Refusing to share ${id}: it is quarantined pending review. Approve it first via 'hippo quarantine approve ${id}'.`,
    );
  }
  if (isPersonalScope(entry.scope ?? null)) {
    throw new BadRequestError(`Refusing to share ${id}: it is a personal memory and stays with its owner on this server.`);
  }
}

/** List all projects that contributed memories to the global store, parsed from 'shared:<project>:' or 'promoted:<path>' sources.
 *  `tenantId` filters to one tenant; undefined is host-wide (legacy callers: CLI standalone, dashboard). */
export function listPeers(
  globalRoot?: string,
  tenantId?: string,
): Array<{ project: string; count: number; latest: string }> {
  const root = globalRoot ?? getGlobalRoot();
  if (!fs.existsSync(root)) return [];

  // Tenant-scoped by default when tenantId provided. Host-wide when
  // undefined (preserves back-compat).
  const tallies = tallySources(root, tenantId).sort((a, b) => (a.first < b.first ? -1 : a.first > b.first ? 1 : 0));
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

function isAutoShareCandidate(entry: MemoryEntry, globalContentSet: Set<string>, minScore: number, stats: AutoShareStats | undefined): boolean {
  // shareMemory refuses quarantined and personal rows; filtering here keeps sleep from aborting on one.
  if (isQuarantineScope(entry.scope ?? null) || isPersonalScope(entry.scope ?? null) || !isReusable(entry)) return false;
  // Before the score: these rows describe one project only, and a git seed's 'error' tag clears the bar.
  if (entry.tags.some((t) => NEVER_AUTO_SHARE_TAGS.has(t)) || entry.source.startsWith(AGENT_MEMORY_SOURCE_PREFIX)) {
    if (stats) stats.neverAutoShareSkipped = (stats.neverAutoShareSkipped ?? 0) + 1;
    return false;
  }
  const score = transferScore(entry);
  if (score < minScore) return false;

  // Skip if already shared (same text apart from spacing)
  if (globalContentSet.has(duplicateKey(entry.content))) return false;

  // Secret veto, checked LAST so the stats counter only counts rows it withheld (a row failing the score or dedupe gate was never going to share).
  // shareMemory would throw here; filtering keeps the sleep pipeline fail-safe.
  if (detectSecret(entry).flagged) {
    if (stats) stats.secretSkipped++;
    return false;
  }

  return true;
}

// Rejection containment: shareMemory -> writeEntry can throw RejectedValueError against the GLOBAL store tombstones and abort the autoShare sleep phase.
// Catch per item like syncGlobalToLocal; writeEntry already audits reject_refusal before rethrowing, so count and continue.
function shareCandidates(localRoot: string, candidates: readonly MemoryEntry[], stats: AutoShareStats | undefined): MemoryEntry[] {
  const shared: MemoryEntry[] = [];
  let rejectedSkipped = 0;
  for (const entry of candidates) {
    try {
      // skipEmbed: batching invariant, this is a batch producer, so it embeds
      // once via embedAll() below rather than once per row inside shareMemory.
      const result = shareMemory(localRoot, entry.id, { force: true, skipEmbed: true });
      if (result) shared.push(result);
    } catch (err) {
      if (err instanceof RejectedValueError) {
        rejectedSkipped++;
        if (stats) stats.rejectedSkipped = (stats.rejectedSkipped ?? 0) + 1;
        continue;
      }
      throw err;
    }
  }

  if (rejectedSkipped > 0) {
    log.warn(
      `autoShare: skipped ${rejectedSkipped} candidate(s) refused by the global store's rejection tombstone`,
    );
  }
  return shared;
}

/** Auto-share local memories with high transfer scores, not already global and without a NEVER_AUTO_SHARE_TAGS tag; `options.tenantId` scopes the LOCAL read.
 *  `options.stats` is an opt-in out-param: `secretSkipped` counts shares the secret veto prevented, `rejectedSkipped` rejection refusals (0 under `dryRun`). */
export function autoShare(
  localRoot: string,
  options: {
    minScore?: number;
    dryRun?: boolean;
    tenantId?: string;
    stats?: AutoShareStats;
  } = {},
): MemoryEntry[] {
  const { minScore = 0.6, dryRun = false } = options;

  const localEntries = loadAllEntries(localRoot, options.tenantId);
  initGlobal();
  const globalRoot = getGlobalRoot();
  // Host-wide read. The global store IS the union across all tenants;
  // per-tenant filtering on the global root would defeat the purpose.
  const globalEntries = loadAllEntries(globalRoot);

  // Build set of global content hashes to avoid duplicates
  const globalContentSet = storedTextKeys(globalEntries);

  const candidates = localEntries.filter((entry) => isAutoShareCandidate(entry, globalContentSet, minScore, options.stats));

  if (dryRun) return candidates;

  const shared = shareCandidates(localRoot, candidates, options.stats);

  if (shared.length > 0) {
    void embedAll(globalRoot).catch((err) => logEmbedAllFailure('autoShare', err));
  }

  return shared;
}
