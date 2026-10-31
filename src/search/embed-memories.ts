// Embeds memories into the vector index: picks the configured provider, computes each vector and hands it to the store,
// which only keeps it (src/store/port.ts VectorWrites).

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { MemoryEntry } from '../core/memory.js';
import { loadConfig } from '../core/config.js';
import { initializeParticle } from '../core/physics.js';
import { resolveEmbeddingProvider, type EmbeddingProvider } from '../embeddings/provider.js';
import {
  embeddingIndexIdentity,
  embeddingInputText,
  embeddingModelRequiresReindex,
  indexNeedsRebuild,
  saveStoredEmbeddingModel,
} from '../store/embeddings/index.js';
import { countAllEntries, loadAllEntryIds, loadEntriesByIds } from '../store/entry-reads.js';
import {
  requireGroup,
  type HippoStore,
  type VectorReads,
  type VectorRowWrite,
  type VectorWrite,
  type VectorWriteResult,
  type VectorWrites,
} from '../store/port.js';
import {
  indexedModel,
  pruneStoredVectorsListPending,
  replacesIndex,
  resetStoredParticles,
  saveEmbeddingIndex,
  saveStoredVectors,
  seedStoredParticle,
} from '../store/vector-index.js';
import { chunked } from '../util/chunked.js';
import { envByName } from '../util/env.js';
import { errorCode, errorMessage, log, errorFields } from '../util/log.js';
import { redactSecretsStrict } from '../util/secret-detect.js';
import { MINUTE_MS } from '../util/time.js';

const STORE_PAGE = 64;

/** The rows for `ids`, a page at a time and in that order; an id deleted since it was listed is skipped. */
function* entryPages(hippoRoot: string, ids: readonly string[]): Generator<MemoryEntry[]> {
  for (const page of chunked(ids, STORE_PAGE)) {
    const byId = new Map(loadEntriesByIds(hippoRoot, page).map((e) => [e.id, e]));
    const entries = page.flatMap((id) => byId.get(id) ?? []);
    if (entries.length > 0) yield entries;
  }
}

async function rebuildEmbeddingIndex(
  hippoRoot: string,
  ids: readonly string[],
  provider: EmbeddingProvider,
): Promise<Record<string, number[]>> {
  const rebuilt: Record<string, number[]> = {};
  for (const entries of entryPages(hippoRoot, ids)) {
    // On a hard transport/auth failure provider.embed throws, so the caller aborts WITHOUT saving
    // a partial index (atomic reindex: the old index + stored identity are preserved).
    const vectors = await provider.embed(entries.map((e) => embeddingInputText(e)), 'passage');
    for (let i = 0; i < entries.length; i++) {
      const vec = vectors[i];
      if (vec && vec.length > 0) {
        rebuilt[entries[i].id] = vec;
      } else {
        noteSkippedEmbedding(entries[i].id);
      }
    }
  }

  return rebuilt;
}

function resetPhysicsFromIndex(
  hippoRoot: string,
  ids: readonly string[],
  index: Record<string, number[]>,
): void {
  try {
    resetStoredParticles(hippoRoot, ids, index);
  } catch (err) {
    // Best effort: retrieval still falls back without physics state.
    log.warn(`physics reset after reindex failed: ${errorMessage(err)}`, errorFields(err));
  }
}

/** A provider's `[]` row is a swallowed per-item failure; name the memory so the gap can be traced. */
function noteSkippedEmbedding(id: string): void {
  log.warn('memory not embedded; the next embed run retries it', { id });
}

const EMBED_LOCK_FILE = 'embeddings.lock';
const EMBED_LOCK_WAIT_MS = 10_000;
const EMBED_LOCK_OWNER = `${process.pid}:${randomUUID()}`;

// In-process mutex plus an O_EXCL "<pid>:<token>" lock file: our token is a lock we leaked; our PID
// with another token is a live worker thread, unless the lock predates this process (a reused PID).
let _embedWriteLock: Promise<void> = Promise.resolve();

function embedLockHolderAlive(lockPath: string): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch (err) {
    return !(err instanceof Error && 'code' in err && err.code === 'ENOENT');
  }
  const mtimeMs = fs.statSync(lockPath, { throwIfNoEntry: false })?.mtimeMs ?? 0;
  const pid = Number(raw.split(':')[0]);
  // An empty lock is a holder between create and write; after 5 s it is a crashed one.
  if (!Number.isInteger(pid) || pid <= 0) return Date.now() - mtimeMs < 5_000;
  if (raw === EMBED_LOCK_OWNER) return false;
  if (pid === process.pid) return mtimeMs >= Date.now() - process.uptime() * 1000;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err instanceof Error && 'code' in err && err.code === 'EPERM';
  }
}

// After the double-break race below the file can be another writer's lock, so remove only our own.
function releaseEmbedFileLock(lockPath: string): void {
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return;
    throw err;
  }
  if (raw === EMBED_LOCK_OWNER) fs.rmSync(lockPath, { force: true });
}

async function acquireEmbedFileLock(hippoRoot: string): Promise<() => void> {
  const lockPath = path.join(hippoRoot, EMBED_LOCK_FILE);
  const deadline = Date.now() + EMBED_LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.writeFileSync(lockPath, EMBED_LOCK_OWNER, { flag: 'wx' });
      return () => releaseEmbedFileLock(lockPath);
    } catch (err) {
      if (!(err instanceof Error && 'code' in err && err.code === 'EEXIST')) throw err;
    }
    // SHORTCUT: two waiters can both break one dead holder's lock; a vector lost that way is backfilled by the next
    // `hippo embed`.
    if (!embedLockHolderAlive(lockPath)) {
      fs.rmSync(lockPath, { force: true });
      continue;
    }
    if (Date.now() >= deadline) throw new Error(`the embedding index is busy: another hippo process holds ${lockPath}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function withEmbedLock<T>(hippoRoot: string, fn: () => Promise<T>): Promise<T> {
  return withProcessEmbedLock(async () => {
    const release = await acquireEmbedFileLock(hippoRoot);
    try {
      return await fn();
    } finally {
      release();
    }
  });
}

// A store keeps each write whole in its own transaction, and a
// lock file in hippoRoot would not reach a worker on another host.
async function withProcessEmbedLock<T>(fn: () => Promise<T>): Promise<T> {
  let resolve!: () => void;
  const next = new Promise<void>(r => { resolve = r; });
  const prev = _embedWriteLock;
  _embedWriteLock = next;
  await prev;
  try {
    return await fn();
  } finally {
    resolve();
  }
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
  const message = redactSecretsStrict(rawMessage).replace(/\s+/g, ' ').replace(/\.+$/, '');
  log.warn(`embedding failed (${source}): ${message}. Memories are stored without embeddings until this is fixed.`);
}

function vectorGroups(store: HippoStore): readonly [VectorReads, VectorWrites] {
  return [requireGroup(store, 'vectors'), requireGroup(store, 'vectorWrites')];
}

/** Writes one page's vectors, one writeVectors per tenant, and stops at the first refused write; `withParticles`
 * seeds each memory's particle. */
async function writeVectorPage(
  writes: VectorWrites,
  write: Pick<VectorWrite, 'model' | 'replaceIndex'>,
  page: readonly MemoryEntry[],
  vectors: readonly number[][],
  withParticles: boolean,
): Promise<VectorWriteResult> {
  const byTenant = new Map<string, VectorRowWrite[]>();
  page.forEach((entry, i) => {
    const vector = vectors[i];
    if (!vector || vector.length === 0) return noteSkippedEmbedding(entry.id);
    const row: VectorRowWrite = withParticles
      ? { memoryId: entry.id, vector, particle: initializeParticle(entry, vector) }
      : { memoryId: entry.id, vector };
    byTenant.set(entry.tenant_id, [...(byTenant.get(entry.tenant_id) ?? []), row]);
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
): Promise<number> {
  let count = 0;
  let afterId: string | undefined;
  for (;;) {
    const page = await writes.entriesWithoutVector({ model, afterId, limit: STORE_PAGE });
    if (page.length === 0) return count;
    afterId = page[page.length - 1].id;
    const vectors = await provider.embed(
      page.map((e) => embeddingInputText(e)),
      'passage',
    );
    const result = await writeVectorPage(writes, { model, replaceIndex: rebuild }, page, vectors, rebuild);
    // Another process rebuilt the index mid-run; every later page
    // would be refused too, after paying the provider for it.
    if (result.modelMismatch) throw new Error(OTHER_MODEL_INDEX);
    count += result.written;
  }
}

/** embedAll on a store: a model change re-embeds every memory, and the first page written drops the old index. */
async function embedAllInStore(store: HippoStore, provider: EmbeddingProvider): Promise<number> {
  const [reads, writes] = vectorGroups(store);
  const rebuild = indexNeedsRebuild(indexedModel(await reads.embeddingIndexState()), provider.id);
  return backfillInStore(writes, provider, embeddingIndexIdentity(provider.id), rebuild);
}

/** embedMemory on a store; like the hippo.db path it resolves whatever fails. Unlike it, it leaves a model change to
 * embedAll, so a stale
 * read here never drops another process's rebuild; the read only saves a paid embed call, as the write refuses
 * another model itself. */
function embedMemoryInStore(store: HippoStore, provider: EmbeddingProvider, entry: MemoryEntry): Promise<EmbedOutcome> {
  return withProcessEmbedLock(async () => {
    const [reads, writes] = vectorGroups(store);
    const model = embeddingIndexIdentity(provider.id);
    try {
      const refused = replacesIndex(await reads.embeddingIndexState(), model)
        || (await writeVectorPage(
          writes,
          { model, replaceIndex: false },
          [entry],
          await provider.embed([embeddingInputText(entry)], 'passage'),
          true
        )).modelMismatch;
      if (refused) warnEmbedFailureOnce('index', OTHER_MODEL_INDEX);
      return refused ? 'failed' : 'indexed';
    } catch (err) {
      warnEmbedFailureOnce(provider.kind, errorMessage(err), err);
      return 'failed';
    }
  }).catch((err): EmbedOutcome => {
    log.warn(`skipped embedding ${entry.id} (${errorMessage(err)})`, errorFields(err));
    return 'failed';
  });
}

const INLINE_REINDEX_MAX_ROWS = 256;

/** `off` is a provider that is disabled or not installed, which is a choice; `failed` is a memory that stays out of
 * the vector index. */
export type EmbedOutcome = 'indexed' | 'off' | 'failed';

/** Embed a single memory entry and cache the result in the embedding index; with `store`, through its vectorWrites,
 * never opening hippo.db.
 * Resolves whatever fails, so a caller that fires and forgets stays safe; the outcome says whether the memory
 * reached the index. */
export async function embedMemory(
  hippoRoot: string,
  entry: MemoryEntry,
  model?: string,
  store?: HippoStore,
): Promise<EmbedOutcome> {
  let provider: EmbeddingProvider;
  let available: boolean;
  try {
    provider = resolveEmbeddingProvider(hippoRoot, { model });
    available = provider.isAvailable();
  } catch (err) {
    // Callers fire and forget, so this must resolve: a bad config warns once instead of rejecting.
    warnEmbedFailureOnce('config', errorMessage(err), err);
    return 'failed';
  }
  if (!available) return 'off';
  if (store) return embedMemoryInStore(store, provider, entry);

  return withEmbedLock(hippoRoot, () => embedMemoryLocked(hippoRoot, provider, entry)).catch((err): EmbedOutcome => {
    log.warn(`skipped embedding ${entry.id} (${errorMessage(err)}); run 'hippo embed' to backfill`, errorFields(err));
    return 'failed';
  });
}

/** Best-effort: an embedding failure (API down, bad key, 5xx) must not reject the caller's write; the existing index is
 * left as-is.
 *  Failures surface on the explicit `hippo embed` / `embedAll` path. */
async function embedMemoryLocked(
  hippoRoot: string,
  provider: EmbeddingProvider,
  entry: MemoryEntry,
): Promise<EmbedOutcome> {
  try {
    const identity = provider.id;
    if (embeddingModelRequiresReindex(hippoRoot, identity)) {
      // A fire-and-forget write heals a small index inline; a large one is left to `hippo embed`, so no write holds the
      // lock for a whole-store embed.
      if (countAllEntries(hippoRoot) > INLINE_REINDEX_MAX_ROWS) {
        warnEmbedFailureOnce('index', OTHER_MODEL_INDEX);
        return 'failed';
      }
      await rebuildIndexForProvider(hippoRoot, provider);
      return 'indexed';
    }

    const [vector] = await provider.embed([embeddingInputText(entry)], 'passage');
    if (!vector || vector.length === 0) return 'failed';

    saveStoredVectors(hippoRoot, [[entry.id, vector]], embeddingIndexIdentity(identity));
    saveStoredEmbeddingModel(hippoRoot, identity);
    initializePhysicsIfMissing(hippoRoot, entry, vector);
    return 'indexed';
  } catch (err) {
    // Provider failure (API down / bad key). Best-effort: leave the index as-is, but say so once.
    warnEmbedFailureOnce(provider.kind, errorMessage(err), err);
    return 'failed';
  }
}

// Every page is embedded before one transaction replaces the index, and
// the identity is saved only after that: a provider failure or a crash
// at any earlier point leaves the old identity, so
// embeddingModelRequiresReindex has the next run rebuild from the start.
async function rebuildIndexForProvider(hippoRoot: string, provider: EmbeddingProvider): Promise<number> {
  const identity = provider.id;
  // Host-wide rebuild: one embedding index per hippoRoot, keyed by tenant-scoped entry.id; per-tenant indices would be
  // a larger architecture change.
  const ids = loadAllEntryIds(hippoRoot);
  const rebuiltIndex = await rebuildEmbeddingIndex(hippoRoot, ids, provider);
  saveEmbeddingIndex(hippoRoot, rebuiltIndex, embeddingIndexIdentity(identity));
  saveStoredEmbeddingModel(hippoRoot, identity);
  resetPhysicsFromIndex(hippoRoot, ids, rebuiltIndex);
  return Object.keys(rebuiltIndex).length;
}

function initializePhysicsIfMissing(hippoRoot: string, entry: MemoryEntry, vector: number[]): void {
  try {
    seedStoredParticle(hippoRoot, entry, vector);
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
function throwIfProviderKeyMissing(hippoRoot: string, provider: EmbeddingProvider): void {
  // A configured API provider with a missing key is a misconfiguration: surface it so callers of the exported
  // embedAll() learn nothing was written.
  // Local-not-installed and an explicit enabled=false stay silent no-ops.
  const cfg = loadConfig(hippoRoot).embeddings;
  if (
    provider.kind !== 'local' &&
    cfg.enabled !== false &&
    provider.keyEnv &&
    !envByName(provider.keyEnv)?.trim()
  ) {
    throw new Error(
      `Embedding provider '${provider.kind}' is configured but ${provider.keyEnv} is not set.`,
    );
  }
}

// Embeds entries without a cached vector in save-checkpointed chunks; a `[]` row means that item could not be embedded
// and is retried next run.
// On a hard provider failure mid-backfill the chunks already embedded are persisted (paid progress), then it stops and
// resumes next run.
async function backfillPending(
  hippoRoot: string,
  provider: EmbeddingProvider,
  pending: readonly string[],
  model: string,
): Promise<{ count: number; backfillError: unknown }> {
  let count = 0;
  // Initialized to `undefined` so it stays a plain `unknown` binding for the arbitrary caught value; falsy either way.
  let backfillError: unknown = undefined;
  for (const chunk of entryPages(hippoRoot, pending)) {
    let vectors: number[][];
    try {
      vectors = await provider.embed(
        chunk.map((e) => embeddingInputText(e)),
        'passage',
      );
    } catch (err) {
      // Preserve the chunks already saved this run, then surface the failure
      // below so the explicit `hippo embed` path never reports a false success.
      backfillError = err;
      break;
    }
    const rows: Array<[string, number[]]> = [];
    for (let j = 0; j < chunk.length; j++) {
      const vec = vectors[j];
      if (vec && vec.length > 0) rows.push([chunk[j].id, vec]);
      else noteSkippedEmbedding(chunk[j].id);
    }
    count += saveStoredVectors(hippoRoot, rows, model);
  }
  return { count, backfillError };
}

/** Embeds every entry with no cached vector, prunes vectors of deleted memories, and returns how many it embedded;
 * `provider` defaults to the
 * configured one. With `store`, every tenant's memories with no vector for the provider's model go through its
 * `vectorWrites`, never hippo.db. */
export async function embedAll(
  hippoRoot: string,
  model?: string,
  provider: EmbeddingProvider = resolveEmbeddingProvider(hippoRoot, { model }),
  store?: HippoStore,
): Promise<number> {
  if (!provider.isAvailable()) {
    throwIfProviderKeyMissing(hippoRoot, provider);
    return 0;
  }
  if (store) return withProcessEmbedLock(() => embedAllInStore(store, provider));

  return withEmbedLock(hippoRoot, async () => {
    const identity = provider.id;
    if (embeddingModelRequiresReindex(hippoRoot, identity)) return rebuildIndexForProvider(hippoRoot, provider);

    // Host-wide by design: embedAll backfills all tenants'
    // entries into the per-host index; per-tenant filtering
    // would produce partial indices and break recall.
    const pending = pruneStoredVectorsListPending(hippoRoot);
    const { count, backfillError } = await backfillPending(
      hippoRoot,
      provider,
      pending,
      embeddingIndexIdentity(identity),
    );

    saveStoredEmbeddingModel(hippoRoot, identity);

    // Partial progress is now persisted; surface a hard backfill failure so the
    // explicit embed path reports it (best-effort callers go via embedMemory).
    if (backfillError) throw backfillError;
    return count;
  });
}
