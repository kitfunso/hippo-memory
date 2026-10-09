/**
 * Optional embedding-based semantic search for Hippo.
 * Uses @huggingface/transformers (local, zero API keys, ~22MB model).
 * Falls back silently if the library is not installed.
 */

import { envByName } from './env.js';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { MemoryEntry } from './memory.js';
import { loadAllEntries } from './store/entry-reads.js';
import { openHippoDb, closeHippoDb, getMeta, rethrowIfSqliteBlocked, setMeta, type DatabaseSyncLike } from './db.js';
import {
  EMBEDDING_MODEL_META_KEY, deleteOrphanVectors, hasStoredVectors, loadVectors, replaceAllVectors, storedVectorIds, upsertVectors,
} from './db/vector-store.js';
import { initializeParticle, savePhysicsState, loadPhysicsState, resetAllPhysicsState } from './db/physics-state.js';
import { loadConfig } from './config.js';
import { resolveEmbeddingProvider, type EmbeddingProvider } from './embedding-provider.js';
import { DEFAULT_EMBEDDING_MODEL } from './local-embedding.js';
import { redactSecretsStrict } from './secret-detect.js';
import { errorMessage, log } from './log.js';
import { StoreNotPortedError } from './util/sqlite-blocked.js';
import type { HippoStore, VectorReads, VectorRowWrite, VectorWrite, VectorWriteResult, VectorWrites } from './store-port.js';

export { EMBEDDING_MODEL_META_KEY };

/**
 * Bump whenever `embeddingInputText`'s composition changes in a way that
 * changes the resulting vectors for existing entries. Folded into the stored
 * index identity (see `embeddingIndexIdentity`) so a text-format change is
 * treated exactly like an embedding-model change: the next embed-touching
 * operation detects the mismatch and reindexes automatically. Format 2 =
 * `path:*` tags excluded (see `embeddingInputText`); format 1 (implicit, no
 * suffix) = `${content} ${tags.join(' ')}` including path tags.
 */
export const EMBED_TEXT_FORMAT = 2;

/**
 * The stored-index identity for a given embedding provider id: folds
 * `EMBED_TEXT_FORMAT` into the provider id so index-identity comparisons
 * automatically invalidate on either a model change OR a text-format change.
 * This is the ONE choke point both `embeddingModelRequiresReindex` (compare
 * side) and `saveStoredEmbeddingModel` (save side) go through — they MUST
 * version identically, or every call reindexes in a loop (or none ever do).
 */
export function embeddingIndexIdentity(providerId: string): string {
  return `${providerId}#t${EMBED_TEXT_FORMAT}`;
}

/**
 * Build the text embedded for a memory entry: content plus its tags, joined
 * by a space and trimmed — the same shape as the legacy
 * `` `${e.content} ${e.tags.join(' ')}`.trim() `` composition, minus `path:*`
 * tags.
 *
 * `path:*` tags are excluded because they are auto-derived from
 * `process.cwd()` (see `extractPathTags` in cli.ts) and carry every path
 * component of the store's location, INCLUDING the store directory name
 * itself. That means identical content embeds to a DIFFERENT vector
 * depending on WHERE the store happens to live — e.g. a fresh benchmark run
 * under `tempfile.mkdtemp()` gets a new directory name (hence new path
 * tokens, hence a new vector) every single run, even with byte-identical
 * content ingested in byte-identical order. This was diagnosed as the
 * DOMINANT root cause of cross-fresh-ingest recall-rank variance measured on
 * LoCoMo (mean evidence-recall@5 stdev 0.0175 across 4 fresh re-ingests of
 * identical data; see `benchmarks/LOCOMO_INVESTIGATION.md`, "Determinism
 * characterization"). It is a real product defect beyond benchmarks too:
 * retrieval semantics should not depend on a project directory's name.
 *
 * Only `path:*` is excluded. Other tags (`conv:`, `session:`, `speaker:`,
 * `dia:`, `error`, `scope:`, etc.) remain embedded — they carry semantic
 * meaning. Path relevance at recall time is already handled explicitly by
 * the v39 scope-isolation layer (`origin_project`, `pathOverlapScore`), so
 * embedding-level path tokens are redundant with a dedicated mechanism
 * rather than a feature.
 */
export function embeddingInputText(entry: { content: string; tags: string[] }): string {
  const tags = entry.tags.filter((t) => !t.startsWith('path:'));
  return `${entry.content} ${tags.join(' ')}`.trim();
}

function loadStoredEmbeddingModel(hippoRoot: string): string | null {
  try {
    const db = openHippoDb(hippoRoot);
    try {
      const model = getMeta(db, EMBEDDING_MODEL_META_KEY, '').trim();
      return model || null;
    } finally {
      closeHippoDb(db);
    }
  } catch (err) {
    rethrowIfSqliteBlocked(err);
    log.debug(`stored embedding model unreadable: ${errorMessage(err)}`);
    return null;
  }
}

/**
 * Persist the stored-index identity for `model` (see `embeddingIndexIdentity`).
 * Versioning happens INSIDE this function, not at call sites, so every caller
 * — current and future — gets the identity format for free. Must stay
 * consistent with the compare side in `embeddingModelRequiresReindex`.
 */
export function saveStoredEmbeddingModel(hippoRoot: string, model: string): void {
  const db = openHippoDb(hippoRoot);
  try {
    setMeta(db, EMBEDDING_MODEL_META_KEY, embeddingIndexIdentity(model));
  } finally {
    closeHippoDb(db);
  }
}

/** What a store's vector index was built by: the stored identity, and whether any vector exists. */
export interface EmbeddingIndexState {
  readonly storedModel: string | null;
  readonly hasVectors: boolean;
}

/** The model the index was built by: the stored identity, else the default model when vectors exist. */
export function indexedModel(state: EmbeddingIndexState): string | null {
  return state.storedModel ?? (state.hasVectors ? DEFAULT_EMBEDDING_MODEL : null);
}

/** The one rebuild rule every store applies to its indexed model. */
export function indexNeedsRebuild(indexed: string | null, providerId: string): boolean {
  return indexed !== null && indexed !== embeddingIndexIdentity(providerId);
}

/** Whether a vector write under the index identity `model` first drops the stored index, which another model built. */
export function replacesIndex(state: EmbeddingIndexState, model: string): boolean {
  const indexed = indexedModel(state);
  return indexed !== null && indexed !== model;
}

export function resolveIndexedEmbeddingModel(
  hippoRoot: string,
  index?: Record<string, number[]>,
): string | null {
  const storedModel = loadStoredEmbeddingModel(hippoRoot);
  if (storedModel) return storedModel;
  return indexedModel({ storedModel, hasVectors: index ? Object.keys(index).length > 0 : withVectorDb(hippoRoot, hasStoredVectors) });
}

export function embeddingModelRequiresReindex(
  hippoRoot: string,
  model: string,
  index?: Record<string, number[]>,
): boolean {
  return indexNeedsRebuild(resolveIndexedEmbeddingModel(hippoRoot, index), model);
}

/** hippo.db's index state, the meta row and the EXISTS on one handle. */
export function embeddingIndexStateAt(hippoRoot: string): EmbeddingIndexState {
  return withVectorDb(hippoRoot, embeddingIndexStateOn);
}

export function embeddingIndexStateOn(db: DatabaseSyncLike): EmbeddingIndexState {
  return {
    storedModel: getMeta(db, EMBEDDING_MODEL_META_KEY, '').trim() || null,
    hasVectors: hasStoredVectors(db),
  };
}

async function rebuildEmbeddingIndex(
  entries: MemoryEntry[],
  provider: EmbeddingProvider,
): Promise<Record<string, number[]>> {
  const rebuilt: Record<string, number[]> = {};
  if (entries.length === 0) return rebuilt;

  const texts = entries.map((e) => embeddingInputText(e));
  // provider.embed batches internally; on a hard transport/auth failure it
  // throws, so the caller aborts WITHOUT saving a partial index (atomic
  // reindex: the old index + stored identity are preserved).
  const vectors = await provider.embed(texts, 'passage');
  for (let i = 0; i < entries.length; i++) {
    const vec = vectors[i];
    if (vec && vec.length > 0) {
      rebuilt[entries[i].id] = vec;
    } else {
      noteSkippedEmbedding(entries[i].id);
    }
  }

  return rebuilt;
}

function resetPhysicsFromIndex(
  hippoRoot: string,
  entries: MemoryEntry[],
  index: Record<string, number[]>,
): void {
  try {
    const db = openHippoDb(hippoRoot);
    try {
      resetAllPhysicsState(db, entries, index);
    } finally {
      closeHippoDb(db);
    }
  } catch (err) {
    // Best effort: retrieval still falls back without physics state.
    log.warn(`physics reset after reindex failed: ${errorMessage(err)}`);
  }
}

/** A provider's `[]` row is a swallowed per-item failure; name the memory so the gap can be traced. */
function noteSkippedEmbedding(id: string): void {
  log.warn('memory not embedded; the next embed run retries it', { id });
}

/**
 * Cosine similarity between two vectors. Handles unnormalized vectors.
 * Returns 0 for empty or mismatched vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom < 1e-10) return 0;
  // Clamp to [-1, 1] to handle floating point drift
  return Math.min(1, Math.max(-1, dot / denom));
}

function withVectorDb<T>(hippoRoot: string, fn: (db: DatabaseSyncLike) => T): T {
  const db = openHippoDb(hippoRoot);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

/** Every stored vector keyed by memory id; `{}` when none. Search reads only the rows it ranks via `loadStoredVectors`. */
export function loadEmbeddingIndex(hippoRoot: string): Record<string, number[]> {
  return Object.fromEntries(withVectorDb(hippoRoot, (db) => loadVectors(db)));
}

/** Stored vectors for `ids` only. */
export function loadStoredVectors(hippoRoot: string, ids: readonly string[]): Map<string, number[]> {
  return ids.length === 0 ? new Map() : withVectorDb(hippoRoot, (db) => loadVectors(db, ids));
}

/** Replace every stored vector with `index`; `model` defaults to the stored index identity. */
export function saveEmbeddingIndex(hippoRoot: string, index: Record<string, number[]>, model?: string): void {
  withVectorDb(hippoRoot, (db) => replaceAllVectors(db, index, model ?? getMeta(db, EMBEDDING_MODEL_META_KEY, '')));
}

const EMBED_LOCK_FILE = 'embeddings.lock';
const EMBED_LOCK_WAIT_MS = 10_000;
const EMBED_LOCK_OWNER = `${process.pid}:${randomUUID()}`;

// In-process mutex plus an O_EXCL "<pid>:<token>" lock file: our token is a lock we leaked; our PID with another token is a live worker thread, unless the lock predates this process (a reused PID).
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
    // SHORTCUT: two waiters can both break one dead holder's lock; a vector lost that way is backfilled by the next `hippo embed`.
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

// A store keeps each write whole in its own transaction, and a lock file in hippoRoot would not reach a worker on another host.
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

// A bad key fails every write; one warning tells the user, N would bury the command's own output.
let _embedFailureWarned = false;

function warnEmbedFailureOnce(source: string, rawMessage: string): void {
  if (_embedFailureWarned) return;
  _embedFailureWarned = true;
  // Strict scrub: this line can land in a hook log file, and an API may echo the key back in its error body.
  const message = redactSecretsStrict(rawMessage).replace(/\s+/g, ' ').replace(/\.+$/, '');
  log.warn(`embedding failed (${source}): ${message}. Memories are stored without embeddings until this is fixed.`);
}

// store-port.ts imports this module, so its requireGroup would close an import cycle.
function vectorGroups(store: HippoStore): readonly [VectorReads, VectorWrites] {
  if (store.vectors === undefined) throw new StoreNotPortedError(store.kind, 'vectors');
  if (store.vectorWrites === undefined) throw new StoreNotPortedError(store.kind, 'vectorWrites');
  return [store.vectors, store.vectorWrites];
}

/** Writes one page's vectors, one writeVectors per tenant, and stops at the first refused write; `withParticles` seeds each memory's particle. */
async function writeVectorPage(
  writes: VectorWrites, write: Pick<VectorWrite, 'model' | 'replaceIndex'>, page: readonly MemoryEntry[], vectors: readonly number[][], withParticles: boolean,
): Promise<VectorWriteResult> {
  const byTenant = new Map<string, VectorRowWrite[]>();
  page.forEach((entry, i) => {
    const vector = vectors[i];
    if (!vector || vector.length === 0) return noteSkippedEmbedding(entry.id);
    const row: VectorRowWrite = withParticles ? { memoryId: entry.id, vector, particle: initializeParticle(entry, vector) } : { memoryId: entry.id, vector };
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

const STORE_PAGE = 64;
const OTHER_MODEL_INDEX = "the vector index was built by another embedding model; run 'hippo embed' to rebuild it";

/** Embeds every memory with no vector under `model`, page by page, so a provider failure keeps the pages written; a rebuild reseeds the particles it drops. */
async function backfillInStore(writes: VectorWrites, provider: EmbeddingProvider, model: string, rebuild: boolean): Promise<number> {
  let count = 0;
  let afterId: string | undefined;
  for (;;) {
    const page = await writes.entriesWithoutVector({ model, afterId, limit: STORE_PAGE });
    if (page.length === 0) return count;
    afterId = page[page.length - 1].id;
    const vectors = await provider.embed(page.map((e) => embeddingInputText(e)), 'passage');
    const result = await writeVectorPage(writes, { model, replaceIndex: rebuild }, page, vectors, rebuild);
    // Another process rebuilt the index mid-run; every later page would be refused too, after paying the provider for it.
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

/** embedMemory on a store; like the hippo.db path it resolves whatever fails. Unlike it, it leaves a model change to embedAll, so a stale
 *  read here never drops another process's rebuild; the read only saves a paid embed call, as the write refuses another model itself. */
function embedMemoryInStore(store: HippoStore, provider: EmbeddingProvider, entry: MemoryEntry): Promise<void> {
  return withProcessEmbedLock(async () => {
    const [reads, writes] = vectorGroups(store);
    const model = embeddingIndexIdentity(provider.id);
    try {
      const refused = replacesIndex(await reads.embeddingIndexState(), model)
        || (await writeVectorPage(writes, { model, replaceIndex: false }, [entry], await provider.embed([embeddingInputText(entry)], 'passage'), true)).modelMismatch;
      if (refused) warnEmbedFailureOnce('index', OTHER_MODEL_INDEX);
    } catch (err) {
      warnEmbedFailureOnce(provider.kind, errorMessage(err));
    }
  }).catch((err) => {
    log.warn(`skipped embedding ${entry.id} (${errorMessage(err)})`);
  });
}

/** Embed a single memory entry and cache the result in the embedding index; with `store`, through its vectorWrites, never opening hippo.db. */
export async function embedMemory(
  hippoRoot: string,
  entry: MemoryEntry,
  model?: string,
  store?: HippoStore,
): Promise<void> {
  let provider: EmbeddingProvider;
  try {
    provider = resolveEmbeddingProvider(hippoRoot, { model });
  } catch (err) {
    // Callers fire and forget, so this must resolve: a bad config warns once instead of rejecting.
    warnEmbedFailureOnce('config', errorMessage(err));
    return;
  }
  if (!provider.isAvailable()) return;
  if (store) return embedMemoryInStore(store, provider, entry);

  return withEmbedLock(hippoRoot, async () => {
    // embedMemory is best-effort: an embedding failure (API down / bad key / 5xx)
    // must not reject the caller's write — `getEmbedding` historically swallowed
    // failures and returned []. The explicit `hippo embed` / `embedAll` path is
    // where failures surface. On any failure we leave the existing index as-is.
    try {
      const identity = provider.id;

      if (embeddingModelRequiresReindex(hippoRoot, identity)) {
        // Host-wide rebuild. The embedding index is keyed by entry.id
        // (which is tenant-scoped) but the index itself is one per hippoRoot.
        // Cross-tenant content equivalence is visible at the vector level.
        // Per-tenant indices would be a larger architecture change.
        const entries = loadAllEntries(hippoRoot);
        const rebuiltIndex = await rebuildEmbeddingIndex(entries, provider);
        saveEmbeddingIndex(hippoRoot, rebuiltIndex, embeddingIndexIdentity(identity));
        saveStoredEmbeddingModel(hippoRoot, identity);
        resetPhysicsFromIndex(hippoRoot, entries, rebuiltIndex);
        return;
      }

      const text = embeddingInputText(entry);
      const [vector] = await provider.embed([text], 'passage');
      if (!vector || vector.length === 0) return;

      withVectorDb(hippoRoot, (db) => upsertVectors(db, [[entry.id, vector]], embeddingIndexIdentity(identity)));
      saveStoredEmbeddingModel(hippoRoot, identity);

      // Initialize physics state for this memory
      try {
        const db = openHippoDb(hippoRoot);
        try {
          const existing = loadPhysicsState(db, [entry.id]);
          if (!existing.has(entry.id)) {
            const particle = initializeParticle(entry, vector);
            savePhysicsState(db, [particle]);
          }
        } finally {
          closeHippoDb(db);
        }
      } catch (err) {
        // Physics init is best-effort and must not fail the embedding that just landed.
        log.debug(`physics state not initialised for ${entry.id}: ${errorMessage(err)}`);
      }
    } catch (err) {
      // Provider failure (API down / bad key). Best-effort: leave the index as-is, but say so once.
      warnEmbedFailureOnce(provider.kind, errorMessage(err));
    }
  }).catch((err) => {
    log.warn(`skipped embedding ${entry.id} (${errorMessage(err)}); run 'hippo embed' to backfill`);
  });
}

/** Throws when an unavailable provider is a misconfiguration rather than an intentional no-op. */
function throwIfProviderKeyMissing(hippoRoot: string, provider: EmbeddingProvider): void {
  // A configured (non-disabled) API provider with a missing key is a
  // misconfiguration, not a no-op: surface it so programmatic callers of the
  // exported embedAll() learn nothing was written. Local-not-installed and an
  // explicit enabled=false stay silent no-ops (best-effort / intentional).
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

// Embed entries without a cached vector in save-checkpointed chunks.
// provider.embed batches internally (one HTTP request per batchSize for API
// providers; sequential for local). A `[]` row means that single item could
// not be embedded and is left for a later run (resumable). On a hard provider
// failure mid-backfill we persist the chunks already embedded this run rather
// than discarding paid progress, then stop and resume on the next run.
async function backfillPending(
  hippoRoot: string,
  provider: EmbeddingProvider,
  pending: readonly MemoryEntry[],
  model: string,
): Promise<{ count: number; backfillError: unknown }> {
  let count = 0;
  // Initialized to `undefined` (not a known-evidence literal like `null`) so
  // it stays a plain `unknown` binding for the arbitrary caught value below;
  // falsy either way, so `if (backfillError)` behaves identically.
  let backfillError: unknown = undefined;
  const SAVE_CHUNK = 64;
  for (let i = 0; i < pending.length; i += SAVE_CHUNK) {
    const chunk = pending.slice(i, i + SAVE_CHUNK);
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
    count += withVectorDb(hippoRoot, (db) => upsertVectors(db, rows, model));
  }
  return { count, backfillError };
}

/** Embeds every entry with no cached vector, prunes vectors of deleted memories, and returns how many it embedded; `provider` defaults to the
 *  configured one. With `store`, every tenant's memories with no vector for the provider's model go through its `vectorWrites`, never hippo.db. */
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
    // Host-wide by design. embedAll backfills vectors for all tenants'
    // entries into the per-host embedding index. Per-tenant filtering would
    // produce partial indices and break recall.
    const entries = loadAllEntries(hippoRoot);
    const model = embeddingIndexIdentity(identity);

    if (embeddingModelRequiresReindex(hippoRoot, identity)) {
      const rebuiltIndex = await rebuildEmbeddingIndex(entries, provider);
      saveEmbeddingIndex(hippoRoot, rebuiltIndex, model);
      saveStoredEmbeddingModel(hippoRoot, identity);
      resetPhysicsFromIndex(hippoRoot, entries, rebuiltIndex);
      return Object.keys(rebuiltIndex).length;
    }

    const embedded = withVectorDb(hippoRoot, (db) => {
      deleteOrphanVectors(db);
      return storedVectorIds(db);
    });
    const pending = entries.filter((e) => !embedded.has(e.id));
    const { count, backfillError } = await backfillPending(hippoRoot, provider, pending, model);

    saveStoredEmbeddingModel(hippoRoot, identity);

    // Partial progress is now persisted; surface a hard backfill failure so the
    // explicit embed path reports it (best-effort callers go via embedMemory).
    if (backfillError) throw backfillError;
    return count;
  });
}
