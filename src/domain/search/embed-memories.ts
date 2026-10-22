// Embeds memories into the vector index: asks the target's embedder for the configured provider, computes each vector
// and hands it to the store, which only keeps it (src/store/port.ts VectorWrites).

import { strengthOptionsOf, type MemoryEntry, type StrengthOptions } from '../../base/memory/memory.js';
import { initializeParticle } from '../../base/rank/physics.js';
import type { EmbedderFor, EmbeddingProvider } from '../../base/ports/embedder.js';
import type { EmbeddingsConfig, HippoConfig } from '../../base/config/config.js';
import {
  embeddingIndexIdentity,
  embeddingInputText,
  indexedModel,
  indexNeedsRebuild,
  replacesIndex,
} from '../../base/embeddings/index-identity.js';
import type {
  EmbeddingIndex,
  HippoStore,
  VectorRowWrite,
  VectorWrite,
  VectorWriteResult,
  VectorWrites,
} from '../../store/port.js';
import { chunked } from '../../base/util/chunked.js';
import { errorCode, errorMessage, log, errorFields } from '../../base/util/log.js';
import { redactSecretsStrict } from '../../base/util/secret-detect.js';
import { MINUTE_MS } from '../../base/util/time.js';
import { ALL_TENANTS } from '../../base/util/tenant.js';
import { SerialQueues } from '../../base/util/serial-queue.js';

const STORE_PAGE = 64;
// Ids read per keyset page, so neither a large backlog nor a rebuild lists every id at once.
const ID_PAGE = 1000;

/** The rows for `ids`, a page at a time and in that order; an id deleted since it was listed is skipped. */
async function* entryPages(rows: IndexRows, ids: readonly string[]): AsyncGenerator<MemoryEntry[]> {
  for (const page of chunked(ids, STORE_PAGE)) {
    const byId = new Map((await rows.entriesByIds(page, ALL_TENANTS)).map((e) => [e.id, e]));
    const entries = page.flatMap((id) => byId.get(id) ?? []);
    if (entries.length > 0) yield entries;
  }
}

/** Each of `entries` the provider embedded, with its vector; an empty row is named and left for the next run. */
function embeddedRows(entries: readonly MemoryEntry[], vectors: readonly number[][]): Array<[string, number[]]> {
  const rows: Array<[string, number[]]> = [];
  entries.forEach((entry, i) => {
    const vec = vectors[i];
    if (vec && vec.length > 0) rows.push([entry.id, vec]);
    else noteSkippedEmbedding(entry.id);
  });
  return rows;
}

/** Embeds every memory onto `rebuild`, a page of ids and then a page of rows at a time; answers how many it staged. */
async function stageEmbeddingIndex(
  { embeddingIndex: index, rows }: IndexOf,
  rebuild: string,
  provider: EmbeddingProvider,
): Promise<number> {
  let staged = 0;
  let afterId: string | undefined;
  do {
    const page = await index.entryIdsById({ limit: ID_PAGE, afterId });
    for await (const entries of entryPages(rows, page.ids)) {
      // A hard transport or auth failure throws here, before the commit, so the old index and identity stay.
      const vectors = await provider.embed(
        entries.map((e) => embeddingInputText(e)),
        'passage',
      );
      staged += await index.stageRebuild(rebuild, embeddedRows(entries, vectors));
    }
    afterId = page.next ?? undefined;
  } while (afterId !== undefined);
  return staged;
}

async function resetPhysicsFromIndex(index: EmbeddingIndex): Promise<void> {
  try {
    await index.resetParticles();
  } catch (err) {
    // Best effort: retrieval still falls back without physics state.
    log.warn(`physics reset after reindex failed: ${errorMessage(err)}`, errorFields(err));
  }
}

/** A provider's `[]` row is a swallowed per-item failure; name the memory so the gap can be traced. */
function noteSkippedEmbedding(id: string): void {
  log.warn('memory not embedded; the next embed run retries it', { id });
}

const EMBED_LOCK_WAIT_MS = 10_000;
// A held lock is usually a whole embed run, so the polls back off rather than wake 200 times in the budget.
const EMBED_LOCK_FIRST_POLL_MS = 50;
const EMBED_LOCK_MAX_POLL_MS = 1_000;

// One turn at a time per hippo.db or store, then the index's own lock, which other processes and handles honour.
const embedTurns = new SerialQueues<HippoStore | string>();

/** Waits up to EMBED_LOCK_WAIT_MS for the index's lock; the token to release it with. */
async function acquireIndexLock(index: EmbeddingIndex): Promise<string> {
  const deadline = Date.now() + EMBED_LOCK_WAIT_MS;
  for (let wait = EMBED_LOCK_FIRST_POLL_MS; ; wait = Math.min(wait * 2, EMBED_LOCK_MAX_POLL_MS)) {
    const token = await index.tryLock();
    if (token !== null) return token;
    const left = deadline - Date.now();
    if (left <= 0) throw new Error('the embedding index is busy: another hippo process holds its lock');
    // The last poll lands on the deadline, so the wait never runs past the budget.
    await new Promise((r) => setTimeout(r, Math.min(wait, left)));
  }
}

async function withEmbedLock<T>(index: EmbeddingIndex, fn: () => Promise<T>): Promise<T> {
  return embedTurns.run(await index.lockKey(), async () => {
    const token = await acquireIndexLock(index);
    try {
      return await fn();
    } finally {
      await index.unlock(token);
    }
  });
}

// A bad key fails every write; one full warning per distinct failure tells the user, and a count of the repeats follows
// at most once per interval.
const EMBED_WARN_KEY_CAP = 64;
const EMBED_SUPPRESSED_SUMMARY_INTERVAL_MS = MINUTE_MS;
const embedFailureSeen = new Map<string, { lastNoticeAt: number; suppressed: number }>();

function embedFailureKey(source: string, cause: unknown): string {
  const kind = errorCode(cause) || (cause instanceof Error ? cause.constructor.name : 'NonError');
  return `${source}:${kind}`;
}

// A loop, not /\.+$/: that regex retries from every dot, so a provider error with a long run of dots costs O(n^2).
function withoutTrailingDots(text: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === '.') end -= 1;
  return text.slice(0, end);
}

function warnEmbedFailureOnce(source: string, rawMessage: string, cause?: unknown): void {
  const key = embedFailureKey(source, cause);
  const now = Date.now();
  const seen = embedFailureSeen.get(key);
  if (seen) {
    seen.suppressed += 1;
    if (now - seen.lastNoticeAt >= EMBED_SUPPRESSED_SUMMARY_INTERVAL_MS) {
      log.warn(
        `${seen.suppressed} more embedding errors from ${source} since ` +
          `the last notice; memories are still stored without embeddings.`,
      );
      seen.suppressed = 0;
      seen.lastNoticeAt = now;
    }
    return;
  }
  // Oldest key out, so a full map still lets a new failure warn.
  if (embedFailureSeen.size >= EMBED_WARN_KEY_CAP) {
    for (const oldest of embedFailureSeen.keys()) {
      embedFailureSeen.delete(oldest);
      break;
    }
  }
  embedFailureSeen.set(key, { lastNoticeAt: now, suppressed: 0 });
  // Strict scrub: this line can land in a hook log file, and an API may echo the key back in its error body.
  const message = withoutTrailingDots(redactSecretsStrict(rawMessage).replace(/\s+/g, ' '));
  log.warn(`embedding failed (${source}): ${message}. Memories are stored without embeddings until this is fixed.`);
}

/** Writes one page's vectors, one writeVectors per tenant, and stops at the first refused write; `particles`, when
 * given, scores the particle each memory seeds. */
async function writeVectorPage(
  writes: VectorWrites,
  write: Pick<VectorWrite, 'model' | 'replaceIndex'>,
  page: readonly MemoryEntry[],
  vectors: readonly number[][],
  particles: StrengthOptions | undefined,
): Promise<VectorWriteResult> {
  const byTenant = new Map<string, VectorRowWrite[]>();
  page.forEach((entry, i) => {
    const vector = vectors[i];
    if (!vector || vector.length === 0) return noteSkippedEmbedding(entry.id);
    const row: VectorRowWrite = particles
      ? { memoryId: entry.id, vector, particle: initializeParticle(entry, vector, particles) }
      : { memoryId: entry.id, vector };
    byTenant.set(entry.tenantId, [...(byTenant.get(entry.tenantId) ?? []), row]);
  });
  let written = 0;
  for (const [tenantId, rows] of byTenant) {
    const result = await writes.writeVectors({ ...write, tenantId, rows });
    if (result.modelMismatch) return { written, modelMismatch: true };
    written += result.written;
  }
  return { written, modelMismatch: false };
}

const OTHER_MODEL_INDEX = "the vector index was built by another embedding model; run 'hippo embed' to rebuild it";

/** Embeds every memory with no vector under `model`, page by page, so a provider failure keeps the pages written; a
 * rebuild reseeds the particles it drops. */
async function backfillInStore(
  writes: VectorWrites,
  provider: EmbeddingProvider,
  model: string,
  rebuild: boolean,
  strength: StrengthOptions,
): Promise<number> {
  let count = 0;
  let afterId: string | undefined;
  for (;;) {
    const page = await writes.entriesWithoutVector({ model, afterId, limit: STORE_PAGE, tenantId: ALL_TENANTS });
    if (page.length === 0) return count;
    afterId = page[page.length - 1].id;
    const vectors = await provider.embed(
      page.map((e) => embeddingInputText(e)),
      'passage',
    );
    const result = await writeVectorPage(
      writes,
      { model, replaceIndex: rebuild },
      page,
      vectors,
      rebuild ? strength : undefined,
    );
    // Another process rebuilt the index mid-run; every later page would be refused too, after paying the provider for
    // it.
    if (result.modelMismatch) throw new Error(OTHER_MODEL_INDEX);
    count += result.written;
  }
}

/** embedAll on a store: a model change re-embeds every memory, and the first page written drops the old index. */
async function embedAllInStore(
  store: HippoStore,
  provider: EmbeddingProvider,
  strength: StrengthOptions,
): Promise<number> {
  const { vectors: reads, vectorWrites: writes } = store;
  const rebuild = indexNeedsRebuild(indexedModel(await reads.embeddingIndexState()), provider.id);
  return backfillInStore(writes, provider, embeddingIndexIdentity(provider.id), rebuild, strength);
}

/** embedMemory on a store; like the hippo.db path it resolves whatever fails. Unlike it, it leaves a model change to
 * embedAll, so a stale read here never drops another process's rebuild; the read only saves a paid embed call, as the
 * write refuses another model itself. */
function embedMemoryInStore(
  { store, strength }: StoreEmbedTarget,
  provider: EmbeddingProvider,
  entry: MemoryEntry,
): Promise<EmbedOutcome> {
  return embedTurns
    .run(store, async () => {
      const { vectors: reads, vectorWrites: writes } = store;
      const model = embeddingIndexIdentity(provider.id);
      try {
        const refused =
          replacesIndex(await reads.embeddingIndexState(), model) ||
          (
            await writeVectorPage(
              writes,
              { model, replaceIndex: false },
              [entry],
              await provider.embed([embeddingInputText(entry)], 'passage'),
              strength,
            )
          ).modelMismatch;
        if (refused) warnEmbedFailureOnce('index', OTHER_MODEL_INDEX);
        return refused ? 'failed' : 'indexed';
      } catch (err) {
        warnEmbedFailureOnce(provider.kind, errorMessage(err), err);
        return 'failed';
      }
    })
    .catch((err): EmbedOutcome => {
      log.warn(`skipped embedding ${entry.id} (${errorMessage(err)})`, errorFields(err));
      return 'failed';
    });
}

const INLINE_REINDEX_MAX_ROWS = 256;

/** `off` is a provider that is disabled or not installed, which is a choice; `failed` is a memory that stays out of the
 * vector index. */
export type EmbedOutcome = 'indexed' | 'off' | 'failed';

/** Where vectors go: a store's own index under its lock, or a store's vector groups, with the embeddings config that
 * names the provider and the embedder that builds it. */
export type EmbedTarget = IndexEmbedTarget | StoreEmbedTarget;

/** The embeddings config and the root's embedder, which every target carries. */
interface EmbedWith {
  readonly embeddings: EmbeddingsConfig;
  readonly embedderFor: EmbedderFor;
}

/** The rows an index embeds, read by id. */
type IndexRows = Pick<HippoStore, 'entriesByIds'>;

/** A store's own index with the rows it embeds. */
type IndexOf = Pick<IndexEmbedTarget, 'embeddingIndex' | 'rows'>;

export interface IndexEmbedTarget extends EmbedWith {
  readonly embeddingIndex: EmbeddingIndex;
  readonly rows: IndexRows;
}

/** A store's vector groups, with the strength rules the particles a vector write seeds are scored by. */
export interface StoreEmbedTarget extends EmbedWith {
  readonly store: HippoStore;
  readonly strength: StrengthOptions;
}

/** A store with the config its root loaded and the root's embedder, so a write into it embeds with the provider that
 * config names. */
export interface ConfiguredFolder<S extends HippoStore = HippoStore> {
  readonly store: S;
  readonly config: HippoConfig;
  readonly embedderFor: EmbedderFor;
}

/** The store's own index when it keeps one, else its vector groups. */
export function folderIndex({ store, config, embedderFor }: ConfiguredFolder): EmbedTarget {
  const { embeddingIndex } = store;
  const { embeddings } = config;
  if (embeddingIndex !== undefined) {
    const rows: IndexRows = { entriesByIds: (ids, tenantId) => store.entriesByIds(ids, tenantId) };
    return { embeddingIndex, rows, embeddings, embedderFor };
  }
  return { store, embeddings, embedderFor, strength: strengthOptionsOf(config.runtime) };
}

/** Embed a single memory entry and cache the result in the embedding index; with a store, through its vectorWrites.
 * Resolves whatever fails, so a caller that fires and forgets stays safe; the outcome says whether the memory reached
 * the index. */
export async function embedMemory(on: EmbedTarget, entry: MemoryEntry, model?: string): Promise<EmbedOutcome> {
  let provider: EmbeddingProvider;
  let available: boolean;
  try {
    provider = on.embedderFor(on.embeddings, { model });
    available = provider.isAvailable();
  } catch (err) {
    // Callers fire and forget, so this must resolve: a bad config warns once instead of rejecting.
    warnEmbedFailureOnce('config', errorMessage(err), err);
    return 'failed';
  }
  if (!available) return 'off';
  if ('store' in on) return embedMemoryInStore(on, provider, entry);
  const index = on.embeddingIndex;
  return withEmbedLock(index, () => embedMemoryLocked(on, provider, entry)).catch((err): EmbedOutcome => {
    log.warn(`skipped embedding ${entry.id} (${errorMessage(err)}); run 'hippo embed' to backfill`, errorFields(err));
    return 'failed';
  });
}

/** embedMemory for a write that does not wait on its vector. A rejection outside embedMemory's own handling is logged
 * here, since nothing else holds it and an unhandled one ends the process. */
export function embedMemoryDetached(on: EmbedTarget, entry: MemoryEntry): void {
  embedMemory(on, entry).catch((err) => log.warn(`embedding ${entry.id} failed unexpectedly`, errorFields(err)));
}

/** Best-effort: an embedding failure (API down, bad key, 5xx) must not reject the caller's write; the existing index is
 * left as-is.
 * Failures surface on the explicit `hippo embed` / `embedAll` path. */
async function embedMemoryLocked(on: IndexOf, provider: EmbeddingProvider, entry: MemoryEntry): Promise<EmbedOutcome> {
  const index = on.embeddingIndex;
  try {
    const identity = provider.id;
    if (await index.requiresReindex(identity)) {
      // A fire-and-forget write heals a small index inline; a large one is left to `hippo embed`, so no write holds the
      // lock for a whole-store embed.
      if ((await index.entryCount()) > INLINE_REINDEX_MAX_ROWS) {
        warnEmbedFailureOnce('index', OTHER_MODEL_INDEX);
        return 'failed';
      }
      await rebuildIndexForProvider(on, provider);
      return 'indexed';
    }

    const [vector] = await provider.embed([embeddingInputText(entry)], 'passage');
    if (!vector || vector.length === 0) return 'failed';

    await index.saveVectors([[entry.id, vector]], embeddingIndexIdentity(identity));
    await index.saveModel(identity);
    await initializePhysicsIfMissing(index, entry, vector);
    return 'indexed';
  } catch (err) {
    // Provider failure (API down / bad key). Best-effort: leave the index as-is, but say so once.
    warnEmbedFailureOnce(provider.kind, errorMessage(err), err);
    return 'failed';
  }
}

// Every page is staged apart from the live index, then one transaction swaps the vectors and the identity in: a
// provider failure or a crash before it leaves the old pair, so the next run rebuilds from the start.
async function rebuildIndexForProvider(on: IndexOf, provider: EmbeddingProvider): Promise<number> {
  const index = on.embeddingIndex;
  // Host-wide rebuild: one embedding index per hippoRoot, keyed by tenant-scoped entry.id; per-tenant indices would be
  // a larger architecture change.
  const rebuild = await index.beginRebuild();
  let staged: number;
  try {
    staged = await stageEmbeddingIndex(on, rebuild, provider);
    await index.commitRebuild(rebuild, embeddingIndexIdentity(provider.id));
  } finally {
    await index.closeRebuild(rebuild);
  }
  await resetPhysicsFromIndex(index);
  return staged;
}

async function initializePhysicsIfMissing(index: EmbeddingIndex, entry: MemoryEntry, vector: number[]): Promise<void> {
  try {
    await index.seedParticle(entry, vector);
  } catch (err) {
    // Physics init is best-effort and must not fail the embedding that just landed.
    log.warnThenDebug(
      'physics-state-seed',
      `physics state not initialised for ${entry.id}: ${errorMessage(err)}`,
      errorFields(err),
    );
  }
}

/** Throws when an unavailable provider is a misconfiguration rather than an intentional no-op. */
function throwIfProviderKeyMissing(cfg: EmbeddingsConfig, provider: EmbeddingProvider): void {
  // An enabled API provider is unavailable only when its own read finds no key: a misconfiguration, surfaced so callers
  // of the exported embedAll() learn nothing was written. Local-not-installed and enabled=false stay silent no-ops.
  if (provider.kind !== 'local' && cfg.enabled !== false && provider.keyEnv !== undefined) {
    throw new Error(`Embedding provider '${provider.kind}' is configured but ${provider.keyEnv} is not set.`);
  }
}

// Embeds entries without a cached vector in save-checkpointed chunks; a `[]` row means that item could not be embedded
// and is retried next run.
// On a hard provider failure mid-backfill the chunks already embedded are persisted (paid progress), then it stops and
// resumes next run.
async function backfillPending(
  { embeddingIndex: index, rows }: IndexOf,
  provider: EmbeddingProvider,
  pending: readonly string[],
  model: string,
): Promise<{ count: number; backfillError: unknown }> {
  let count = 0;
  // Initialized to `undefined` so it stays a plain `unknown` binding for the arbitrary caught value; falsy either way.
  let backfillError: unknown = undefined;
  for await (const chunk of entryPages(rows, pending)) {
    let vectors: number[][];
    try {
      vectors = await provider.embed(
        chunk.map((e) => embeddingInputText(e)),
        'passage',
      );
    } catch (err) {
      // Preserve the chunks already saved this run, then surface the failure below so the explicit `hippo embed` path
      // never reports a false success.
      backfillError = err;
      break;
    }
    count += await index.saveVectors(embeddedRows(chunk, vectors), model);
  }
  return { count, backfillError };
}

/** backfillPending over the whole backlog, one page of ids at a time; a hard failure stops after the page it hit. */
async function backfillAllPending(
  on: IndexOf,
  provider: EmbeddingProvider,
  model: string,
): Promise<{ count: number; backfillError: unknown }> {
  let count = 0;
  let afterId: string | undefined;
  do {
    const page = await on.embeddingIndex.pendingIds({ limit: ID_PAGE, afterId });
    const done = await backfillPending(on, provider, page.ids, model);
    count += done.count;
    if (done.backfillError) return { count, backfillError: done.backfillError };
    afterId = page.next ?? undefined;
  } while (afterId !== undefined);
  return { count, backfillError: undefined };
}

/** Embeds every entry with no cached vector, prunes vectors of deleted memories, and returns how many it embedded;
 * `provider` defaults to the one the target's embedder builds. With a store, every tenant's memories with no vector
 * for the provider's model go through its `vectorWrites`. */
export async function embedAll(on: EmbedTarget, model?: string, givenProvider?: EmbeddingProvider): Promise<number> {
  const cfg = on.embeddings;
  const provider = givenProvider ?? on.embedderFor(cfg, { model });
  if (!provider.isAvailable()) {
    throwIfProviderKeyMissing(cfg, provider);
    return 0;
  }
  if ('store' in on) return embedTurns.run(on.store, () => embedAllInStore(on.store, provider, on.strength));
  const index = on.embeddingIndex;
  return withEmbedLock(index, async () => {
    const identity = provider.id;
    if (await index.requiresReindex(identity)) return rebuildIndexForProvider(on, provider);

    // Host-wide by design: embedAll backfills all tenants' entries into the per-host index; per-tenant filtering would
    // produce partial indices and break recall.
    await index.pruneOrphans();
    const { count, backfillError } = await backfillAllPending(on, provider, embeddingIndexIdentity(identity));

    await index.saveModel(identity);

    // Partial progress is now persisted; surface a hard backfill failure so the explicit embed path reports it
    // (best-effort callers go via embedMemory).
    if (backfillError) throw backfillError;
    return count;
  });
}
