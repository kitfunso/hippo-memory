// Embeds memories into the vector index: asks the target's embedder for the configured provider,
// computes each vector and hands it to the store, which only keeps it (src/base/ports/store.ts
// VectorWrites).

import type { MemoryEntry } from '../../base/memory/entry.js';
import type { StrengthModel } from '../../base/memory/strength.js';
import type { Clock, InfraPorts } from '../../base/ports/infra.js';
import { rankStrength } from './boosts.js';
import type { ConfiguredFolder } from '../../base/config/configured-folder.js';
import { initializeParticle } from '../../base/rank/physics.js';
import type { EmbedderFor, EmbeddingProvider } from '../../base/ports/embedder.js';
import type { EmbeddingsConfig } from '../../base/config/config.js';
import {
  embeddingIndexIdentity,
  embeddingInputText,
  indexedModel,
  indexNeedsRebuild,
  replacesIndex,
} from '../../base/embeddings/index-identity.js';
import type {
  EmbeddingIndex,
  IndexStep,
  IndexStepAnswers,
  IndexStepKind,
  VectorRowWrite,
  VectorWrite,
  VectorWriteResult,
  VectorWrites,
  RequiredStore,
  StoreGroups,
  StoreWith,
} from '../../base/ports/store.js';
import { chunked } from '../../base/util/chunked.js';
import { errorCode, errorMessage, log, errorFields } from '../../base/util/log.js';
import { redactSecretsStrict } from '../../base/util/secret-detect.js';
import type { FailureNotices } from '../../base/util/failure-notices.js';
import { ALL_TENANTS } from '../../base/util/tenant.js';
import { SerialQueues } from '../../base/util/serial-queue.js';

const STORE_PAGE = 64;
// Ids read per keyset page, so neither a large backlog nor a rebuild lists every id at once.
const ID_PAGE = 1000;

/** The rows for `ids`, a page at a time and in that order; an id deleted since it was listed is
 * skipped. */
async function* entryPages(rows: IndexRows, ids: readonly string[]): AsyncGenerator<MemoryEntry[]> {
  for (const page of chunked(ids, STORE_PAGE)) {
    const byId = new Map((await rows.entriesByIds(page, ALL_TENANTS)).map((e) => [e.id, e]));
    const entries = page.flatMap((id) => byId.get(id) ?? []);
    if (entries.length > 0) yield entries;
  }
}

/** Each of `entries` the provider embedded, with its vector; an empty row is named and left for
 * the next run. */
function embeddedRows(
  entries: readonly MemoryEntry[],
  vectors: readonly number[][],
): Array<[string, number[]]> {
  const rows: Array<[string, number[]]> = [];
  entries.forEach((entry, i) => {
    const vec = vectors[i];
    if (vec && vec.length > 0) rows.push([entry.id, vec]);
    else noteSkippedEmbedding(entry.id);
  });
  return rows;
}

/** Embeds every memory onto the turn's rebuild, a page of ids and then a page of rows at a time;
 * answers how many it staged. */
async function stageEmbeddingIndex(
  { rows, step }: IndexTurn,
  provider: EmbeddingProvider,
): Promise<number> {
  let staged = 0;
  let afterId: string | undefined;
  do {
    const page = await step({ kind: 'ids', page: { limit: ID_PAGE, afterId } });
    for await (const entries of entryPages(rows, page.ids)) {
      // A hard transport or auth failure throws here, before the commit, so the old index and
      // identity stay.
      const vectors = await provider.embed(
        entries.map((e) => embeddingInputText(e)),
        'passage',
      );
      staged += await step({ kind: 'stage', rows: embeddedRows(entries, vectors) });
    }
    afterId = page.next ?? undefined;
  } while (afterId !== undefined);
  return staged;
}

async function resetPhysicsFromIndex({ step }: IndexTurn): Promise<void> {
  try {
    await step({ kind: 'reset' });
  } catch (err) {
    // Best effort: retrieval still falls back without physics state.
    log.warn(`physics reset after reindex failed: ${errorMessage(err)}`, errorFields(err));
  }
}

/** A provider's `[]` row is a swallowed per-item failure; name the memory so the gap can be
 * traced. */
function noteSkippedEmbedding(id: string): void {
  log.warn('memory not embedded; the next embed run retries it', { id });
}

const EMBED_LOCK_WAIT_MS = 10_000;
// A held lock is usually a whole embed run, so the polls back off rather than wake 200 times in the
// budget.
const EMBED_LOCK_FIRST_POLL_MS = 50;
const EMBED_LOCK_MAX_POLL_MS = 1_000;

// One turn at a time per index, then the index's own lock, which other processes and threads
// honour.
const embedTurns = new SerialQueues<string>();

/** Waits up to EMBED_LOCK_WAIT_MS for the index's lock, which the turn's session holds until it
 * closes. */
async function acquireIndexLock({ step }: IndexTurn): Promise<void> {
  const deadline = Date.now() + EMBED_LOCK_WAIT_MS;
  for (let wait = EMBED_LOCK_FIRST_POLL_MS; ; wait = Math.min(wait * 2, EMBED_LOCK_MAX_POLL_MS)) {
    if (await step({ kind: 'lock' })) return;
    const left = deadline - Date.now();
    if (left <= 0) {
      throw new Error('the embedding index is busy: another hippo process holds its lock');
    }
    // The last poll lands on the deadline, so the wait never runs past the budget.
    await new Promise((r) => setTimeout(r, Math.min(wait, left)));
  }
}

// The close releases the lock inside the turn: a lock with this thread's own token reads as leaked
// to the next turn.
async function withEmbedLock<T>(
  { embeddingIndex: index, rows, failureNotices }: IndexOf,
  fn: (turn: IndexTurn) => Promise<T>,
): Promise<T> {
  const { id, key } = await index.open();
  const turn: IndexTurn = { rows, failureNotices, step: (step) => index.step(id, step) };
  return embedTurns.run(key, async () => {
    try {
      await acquireIndexLock(turn);
      return await fn(turn);
    } finally {
      await turn.step({ kind: 'close' });
    }
  });
}

function embedFailureKey(source: string, cause: unknown): string {
  const kind = errorCode(cause) || (cause instanceof Error ? cause.constructor.name : 'NonError');
  return `${source}:${kind}`;
}

// A loop, not /\.+$/: that regex retries from every dot, so a provider error with a long run of
// dots costs O(n^2).
function withoutTrailingDots(text: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === '.') end -= 1;
  return text.slice(0, end);
}

function warnEmbedFailureOnce(
  notices: FailureNotices,
  source: string,
  rawMessage: string,
  cause?: unknown,
): void {
  const notice = notices.note(embedFailureKey(source, cause), Date.now());
  if (notice === null) return;
  if (notice.kind === 'repeats') {
    log.warn(
      `${notice.count} more embedding errors from ${source} since ` +
        `the last notice; memories are still stored without embeddings.`,
    );
    return;
  }
  // Strict scrub: this line can land in a hook log file, and an API may echo the key back in its
  // error body.
  const message = withoutTrailingDots(redactSecretsStrict(rawMessage).replace(/\s+/g, ' '));
  log.warn(
    `embedding failed (${source}): ${message}. Memories are stored without embeddings until this is fixed.`,
  );
}

interface WriteVectorPageOptions {
  readonly writes: VectorWrites;
  readonly write: Pick<VectorWrite, 'model' | 'replaceIndex'>;
  readonly page: readonly MemoryEntry[];
  readonly vectors: readonly number[][];
  readonly particles: ParticleScoring | undefined;
}

/** Writes one page's vectors, one writeVectors per tenant, and stops at the first refused write;
 * `particles`, when given, scores the particle each memory seeds. */
async function writeVectorPage({
  writes,
  write,
  page,
  vectors,
  particles,
}: WriteVectorPageOptions): Promise<VectorWriteResult> {
  const byTenant = new Map<string, VectorRowWrite[]>();
  page.forEach((entry, i) => {
    const vector = vectors[i];
    if (!vector || vector.length === 0) return noteSkippedEmbedding(entry.id);
    const row: VectorRowWrite = particles
      ? {
          memoryId: entry.id,
          vector,
          particle: initializeParticle(entry, vector, particles.strength, particles.clock()),
        }
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

const OTHER_MODEL_INDEX =
  "the vector index was built by another embedding model; run 'hippo embed' to rebuild it";

interface BackfillInStoreOptions {
  readonly writes: VectorWrites;
  readonly provider: EmbeddingProvider;
  readonly model: string;
  readonly rebuild: boolean;
  readonly particles: ParticleScoring;
}

/** Embeds every memory with no vector under `model`, page by page, so a provider failure keeps
 * the pages written; a rebuild reseeds the particles it drops. */
async function backfillInStore({
  writes,
  provider,
  model,
  rebuild,
  particles,
}: BackfillInStoreOptions): Promise<number> {
  let count = 0;
  let afterId: string | undefined;
  for (;;) {
    const page = await writes.entriesWithoutVector({
      model,
      afterId,
      limit: STORE_PAGE,
      tenantId: ALL_TENANTS,
    });
    if (page.length === 0) return count;
    afterId = page[page.length - 1].id;
    const vectors = await provider.embed(
      page.map((e) => embeddingInputText(e)),
      'passage',
    );
    const result = await writeVectorPage({
      writes,
      write: { model, replaceIndex: rebuild },
      page,
      vectors,
      particles: rebuild ? particles : undefined,
    });
    // Another process rebuilt the index mid-run; every later page would be refused too, after
    // paying the provider for it.
    if (result.modelMismatch) throw new Error(OTHER_MODEL_INDEX);
    count += result.written;
  }
}

/** embedAll on a store: a model change re-embeds every memory, and the first page written drops
 * the old index. */
async function embedAllInStore(
  { groups }: StoreEmbedTarget,
  provider: EmbeddingProvider,
  particles: ParticleScoring,
): Promise<number> {
  const { vectors: reads, vectorWrites: writes } = groups;
  const rebuild = indexNeedsRebuild(indexedModel(await reads.embeddingIndexState()), provider.id);
  return backfillInStore({
    writes,
    provider,
    model: embeddingIndexIdentity(provider.id),
    rebuild,
    particles,
  });
}

/** embedMemory on a store; like the hippo.db path it resolves whatever fails. Unlike it, it
 * leaves a model change to embedAll, so a stale read here never drops another process's rebuild;
 * the read only saves a paid embed call, as the write refuses another model itself. */
async function embedMemoryInStore(
  target: StoreEmbedTarget,
  provider: EmbeddingProvider,
  entry: MemoryEntry,
): Promise<EmbedOutcome> {
  const { vectors: reads, vectorWrites: writes } = target.groups;
  try {
    const model = embeddingIndexIdentity(provider.id);
    const refused =
      replacesIndex(await reads.embeddingIndexState(), model) ||
      (
        await writeVectorPage({
          writes,
          write: { model, replaceIndex: false },
          page: [entry],
          vectors: await provider.embed([embeddingInputText(entry)], 'passage'),
          particles: target,
        })
      ).modelMismatch;
    if (refused) warnEmbedFailureOnce(target.failureNotices, 'index', OTHER_MODEL_INDEX);
    return refused ? 'failed' : 'indexed';
  } catch (err) {
    warnEmbedFailureOnce(target.failureNotices, provider.kind, errorMessage(err), err);
    return 'failed';
  }
}

const INLINE_REINDEX_MAX_ROWS = 256;

/** `off` is a provider that is disabled or not installed, which is a choice; `failed` is a
 * memory that stays out of the vector index. */
export type EmbedOutcome = 'indexed' | 'off' | 'failed';

/** Where vectors go: a store's own index under its lock, or a store's vector groups, with the
 * embeddings config that names the provider and the embedder that builds it. A store with
 * neither has no target, and its rows stay out of every vector search. */
export type EmbedTarget = IndexEmbedTarget | StoreEmbedTarget;

/** The embeddings config, the root's embedder and the failures the root warned about, which
 * every target carries. */
interface EmbedWith {
  readonly embeddings: EmbeddingsConfig;
  readonly embedderFor: EmbedderFor;
  readonly failureNotices: FailureNotices;
}

/** The rows an index embeds, read by id. */
type IndexRows = Pick<RequiredStore, 'entriesByIds'>;

/** A store's own index with the rows it embeds. */
type IndexOf = Pick<IndexEmbedTarget, 'embeddingIndex' | 'rows' | 'failureNotices'>;

/** One session on a store's own index under its lock, with the rows it embeds. */
interface IndexTurn {
  readonly rows: IndexRows;
  readonly failureNotices: FailureNotices;
  readonly step: <K extends IndexStepKind>(step: IndexStep<K>) => Promise<IndexStepAnswers[K]>;
}

export interface IndexEmbedTarget extends EmbedWith {
  readonly embeddingIndex: EmbeddingIndex;
  readonly rows: IndexRows;
}

/** How the particle a vector write seeds is scored: the strength model, at the time the clock
 * gives. */
interface ParticleScoring {
  readonly strength: StrengthModel;
  readonly clock: Clock;
}

/** A store's vector groups, with how the particles a vector write seeds are scored. */
export interface StoreEmbedTarget extends EmbedWith, ParticleScoring {
  readonly groups: Pick<StoreGroups, 'vectors' | 'vectorWrites'>;
}

/** The root's eval switches and clock, which score the particles a vector write seeds, and its
 * warned failures. */
export type EmbedRun = Pick<InfraPorts, 'evalSwitches' | 'clock' | 'failureNotices'>;

/** The store's own index when it keeps one, else its vector groups, whose seeded particles score
 * under `run`; undefined for a store with neither. */
export function folderEmbedTarget(
  { store, config, embedderFor }: ConfiguredFolder<EmbedStore>,
  { evalSwitches: switches, clock, failureNotices }: EmbedRun,
): EmbedTarget | undefined {
  const { embeddingIndex, vectors, vectorWrites } = store;
  const { embeddings } = config;
  if (embeddingIndex !== undefined) {
    const rows: IndexRows = { entriesByIds: (ids, tenantId) => store.entriesByIds(ids, tenantId) };
    return { embeddingIndex, rows, embeddings, embedderFor, failureNotices };
  }
  if (vectors === undefined || vectorWrites === undefined) return undefined;
  const strength = rankStrength({ switches, runtime: config.runtime });
  const groups = { vectors, vectorWrites };
  return { groups, embeddings, embedderFor, failureNotices, strength, clock };
}

/** A store an embed reaches: its own index, else its vector groups; it may keep neither. */
export type EmbedStore = StoreWith<never, 'embeddingIndex' | 'vectors' | 'vectorWrites'>;

/** Embed a single memory entry and cache the result in the embedding index; with a store,
 * through its vectorWrites. Resolves whatever fails, so a caller that fires and forgets stays
 * safe; the outcome says whether the memory reached the index. */
export async function embedMemoryInto(
  on: EmbedTarget | undefined,
  entry: MemoryEntry,
  model?: string,
): Promise<EmbedOutcome> {
  if (on === undefined) return 'off';
  let provider: EmbeddingProvider;
  let available: boolean;
  try {
    provider = on.embedderFor(on.embeddings, { model });
    available = provider.isAvailable();
  } catch (err) {
    // Callers fire and forget, so this must resolve: a bad config warns once instead of rejecting.
    warnEmbedFailureOnce(on.failureNotices, 'config', errorMessage(err), err);
    return 'failed';
  }
  if (!available) return 'off';
  if ('groups' in on) return embedMemoryInStore(on, provider, entry);
  return withEmbedLock(on, (turn) => embedMemoryLocked(turn, provider, entry)).catch(
    (err): EmbedOutcome => {
      log.warn(
        `skipped embedding ${entry.id} (${errorMessage(err)}); run 'hippo embed' to backfill`,
        errorFields(err),
      );
      return 'failed';
    },
  );
}

/** embedMemory for a write that does not wait on its vector. A rejection outside embedMemory's
 * own handling is logged here, since nothing else holds it and an unhandled one ends the
 * process. */
export function embedMemoryDetached(on: EmbedTarget | undefined, entry: MemoryEntry): void {
  embedMemoryInto(on, entry).catch((err) =>
    log.warn(`embedding ${entry.id} failed unexpectedly`, errorFields(err)),
  );
}

/** Best-effort: an embedding failure (API down, bad key, 5xx) must not reject the caller's
 * write; the existing index is left as-is. Failures surface on the explicit `hippo embed` /
 * `embedAll` path. */
async function embedMemoryLocked(
  on: IndexTurn,
  provider: EmbeddingProvider,
  entry: MemoryEntry,
): Promise<EmbedOutcome> {
  const { step } = on;
  try {
    const identity = provider.id;
    if (await step({ kind: 'reindex', providerId: identity })) {
      // A fire-and-forget write heals a small index inline; a large one is left to `hippo embed`,
      // so no write holds the lock for a whole-store embed. A next page means more than
      // INLINE_REINDEX_MAX_ROWS rows.
      if ((await step({ kind: 'ids', page: { limit: INLINE_REINDEX_MAX_ROWS } })).next !== null) {
        warnEmbedFailureOnce(on.failureNotices, 'index', OTHER_MODEL_INDEX);
        return 'failed';
      }
      await rebuildIndexForProvider(on, provider);
      return 'indexed';
    }

    const [vector] = await provider.embed([embeddingInputText(entry)], 'passage');
    if (!vector || vector.length === 0) return 'failed';

    await step({
      kind: 'save',
      rows: [[entry.id, vector]],
      model: embeddingIndexIdentity(identity),
    });
    await step({ kind: 'saveModel', providerId: identity });
    await initializePhysicsIfMissing(on, entry, vector);
    return 'indexed';
  } catch (err) {
    // Provider failure (API down / bad key). Best-effort: leave the index as-is, but say so once.
    warnEmbedFailureOnce(on.failureNotices, provider.kind, errorMessage(err), err);
    return 'failed';
  }
}

// Pages stage apart from the live index, then one transaction swaps vectors and identity in; a
// failure before it leaves the old pair, the session's close drops the staging, and the next run
// rebuilds from the start.
async function rebuildIndexForProvider(
  on: IndexTurn,
  provider: EmbeddingProvider,
): Promise<number> {
  // Host-wide rebuild: one embedding index per hippoRoot, keyed by tenant-scoped entry.id;
  // per-tenant indices would be a larger architecture change.
  await on.step({ kind: 'begin' });
  const staged = await stageEmbeddingIndex(on, provider);
  await on.step({ kind: 'commit', model: embeddingIndexIdentity(provider.id) });
  await resetPhysicsFromIndex(on);
  return staged;
}

async function initializePhysicsIfMissing(
  { step }: IndexTurn,
  entry: MemoryEntry,
  vector: number[],
): Promise<void> {
  try {
    await step({ kind: 'seed', entry, vector });
  } catch (err) {
    // Physics init is best-effort and must not fail the embedding that just landed.
    log.warnThenDebug(
      'physics-state-seed',
      `physics state not initialised for ${entry.id}: ${errorMessage(err)}`,
      errorFields(err),
    );
  }
}

/** One step on a session of its own, closed after, for an index read or write that takes no
 * lock. */
export async function indexStep<K extends IndexStepKind>(
  index: EmbeddingIndex,
  step: IndexStep<K>,
): Promise<IndexStepAnswers[K]> {
  const { id } = await index.open();
  try {
    return await index.step(id, step);
  } finally {
    await index.step(id, { kind: 'close' });
  }
}

/** Throws when an unavailable provider is a misconfiguration rather than an intentional no-op. */
function throwIfProviderKeyMissing(cfg: EmbeddingsConfig, provider: EmbeddingProvider): void {
  // An enabled API provider is unavailable only when its own read finds no key: a misconfiguration,
  // surfaced so callers of the exported embedAll() learn nothing was written. Local-not-installed
  // and enabled=false stay silent no-ops.
  if (provider.kind !== 'local' && cfg.enabled !== false && provider.keyEnv !== undefined) {
    throw new Error(
      `Embedding provider '${provider.kind}' is configured but ${provider.keyEnv} is not set.`,
    );
  }
}

// Embeds entries without a cached vector in save-checkpointed chunks; a `[]` row means that item
// could not be embedded and is retried next run. On a hard provider failure mid-backfill the chunks
// already embedded are persisted (paid progress), then it stops and resumes next run.
async function backfillPending(
  { rows, step }: IndexTurn,
  provider: EmbeddingProvider,
  pending: readonly string[],
  model: string,
): Promise<{ count: number; backfillError: unknown }> {
  let count = 0;
  // Initialized to `undefined` so it stays a plain `unknown` binding for the arbitrary caught
  // value; falsy either way.
  let backfillError: unknown = undefined;
  for await (const chunk of entryPages(rows, pending)) {
    let vectors: number[][];
    try {
      vectors = await provider.embed(
        chunk.map((e) => embeddingInputText(e)),
        'passage',
      );
    } catch (err) {
      // Preserve the chunks already saved this run, then surface the failure below so the explicit
      // `hippo embed` path never reports a false success.
      backfillError = err;
      break;
    }
    count += await step({ kind: 'save', rows: embeddedRows(chunk, vectors), model });
  }
  return { count, backfillError };
}

/** backfillPending over the whole backlog, one page of ids at a time; a hard failure stops after
 * the page it hit. */
async function backfillAllPending(
  on: IndexTurn,
  provider: EmbeddingProvider,
  model: string,
): Promise<{ count: number; backfillError: unknown }> {
  let count = 0;
  let afterId: string | undefined;
  do {
    const page = await on.step({ kind: 'pending', page: { limit: ID_PAGE, afterId } });
    const done = await backfillPending(on, provider, page.ids, model);
    count += done.count;
    if (done.backfillError) return { count, backfillError: done.backfillError };
    afterId = page.next ?? undefined;
  } while (afterId !== undefined);
  return { count, backfillError: undefined };
}

/** Embeds every entry with no cached vector, prunes vectors of deleted memories, and returns how
 * many it embedded; `provider` defaults to the one the target's embedder builds. With a store,
 * every tenant's memories with no vector for the provider's model go through its `vectorWrites`. */
export async function embedAll(
  on: EmbedTarget | undefined,
  model?: string,
  givenProvider?: EmbeddingProvider,
): Promise<number> {
  if (on === undefined) return 0;
  const cfg = on.embeddings;
  const provider = givenProvider ?? on.embedderFor(cfg, { model });
  if (!provider.isAvailable()) {
    throwIfProviderKeyMissing(cfg, provider);
    return 0;
  }
  if ('groups' in on) return embedAllInStore(on, provider, on);
  return withEmbedLock(on, async (turn) => {
    const identity = provider.id;
    if (await turn.step({ kind: 'reindex', providerId: identity })) {
      return rebuildIndexForProvider(turn, provider);
    }

    // Host-wide by design: embedAll backfills all tenants' entries into the per-host index;
    // per-tenant filtering would produce partial indices and break recall.
    await turn.step({ kind: 'prune' });
    const { count, backfillError } = await backfillAllPending(
      turn,
      provider,
      embeddingIndexIdentity(identity),
    );

    await turn.step({ kind: 'saveModel', providerId: identity });

    // Partial progress is now persisted; surface a hard backfill failure so the explicit embed path
    // reports it (best-effort callers go via embedMemory).
    if (backfillError) throw backfillError;
    return count;
  });
}
