import type { MemoryEntry } from '../../base/memory/entry.js';
import type { EmbeddingProvider } from '../../base/ports/embedder.js';
import {
  embeddingIndexIdentity,
  embeddingInputText,
} from '../../base/embeddings/index-identity.js';
import type {
  EmbeddingIndex,
  IndexStep,
  IndexStepAnswers,
  IndexStepKind,
  RequiredStore,
} from '../../base/ports/store.js';
import { chunked } from '../../base/util/chunked.js';
import { errorMessage, log, errorFields } from '../../base/util/log.js';
import type { FailureNotices } from '../../base/util/failure-notices.js';
import { ALL_TENANTS } from '../../base/util/tenant.js';
import type { EmbedOutcome, EmbedWith, EmbedAdapter } from './embed-memories.js';
import { embedTurns } from './embed-turns.js';
import { noteSkippedEmbedding, warnEmbedFailureOnce, OTHER_MODEL_INDEX } from './embed-failures.js';

const ENTRIES_BY_ID_PAGE = 64;

const ID_PAGE = 1000;

async function* entryPages(rows: IndexRows, ids: readonly string[]): AsyncGenerator<MemoryEntry[]> {
  for (const page of chunked(ids, ENTRIES_BY_ID_PAGE)) {
    const byId = new Map((await rows.entriesByIds(page, ALL_TENANTS)).map((e) => [e.id, e]));
    const entries = page.flatMap((id) => byId.get(id) ?? []);
    if (entries.length > 0) yield entries;
  }
}

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

async function stageEmbeddingIndex(
  { rows, step }: IndexTurn,
  provider: EmbeddingProvider,
): Promise<number> {
  let staged = 0;
  let afterId: string | undefined;
  do {
    const page = await step({ kind: 'ids', page: { limit: ID_PAGE, afterId } });
    for await (const entries of entryPages(rows, page.ids)) {
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
    log.warn(`physics reset after reindex failed: ${errorMessage(err)}`, errorFields(err));
  }
}

const EMBED_LOCK_WAIT_MS = 10_000;
const EMBED_LOCK_FIRST_POLL_MS = 50;
const EMBED_LOCK_MAX_POLL_MS = 1_000;

async function acquireIndexLock({ step }: IndexTurn): Promise<void> {
  const deadline = Date.now() + EMBED_LOCK_WAIT_MS;
  for (let wait = EMBED_LOCK_FIRST_POLL_MS; ; wait = Math.min(wait * 2, EMBED_LOCK_MAX_POLL_MS)) {
    if (await step({ kind: 'lock' })) return;
    const left = deadline - Date.now();
    if (left <= 0) {
      throw new Error('the embedding index is busy: another hippo process holds its lock');
    }
    await new Promise((r) => setTimeout(r, Math.min(wait, left)));
  }
}

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

const INLINE_REINDEX_MAX_ROWS = 256;

/** The rows an index embeds, read by id. */
export type IndexRows = Pick<RequiredStore, 'entriesByIds'>;

type IndexOf = Pick<IndexEmbedTarget, 'embeddingIndex' | 'rows' | 'failureNotices'>;

interface IndexTurn {
  readonly rows: IndexRows;
  readonly failureNotices: FailureNotices;
  readonly step: <K extends IndexStepKind>(step: IndexStep<K>) => Promise<IndexStepAnswers[K]>;
}

export interface IndexEmbedTarget extends EmbedWith {
  readonly embeddingIndex: EmbeddingIndex;
  readonly rows: IndexRows;
}

export function indexAdapter(on: IndexEmbedTarget): EmbedAdapter {
  return {
    one: (provider, entry) =>
      withEmbedLock(on, (turn) => embedMemoryLocked(turn, provider, entry)).catch(
        (err): EmbedOutcome => {
          log.warn(
            `skipped embedding ${entry.id} (${errorMessage(err)}); run 'hippo embed' to backfill`,
            errorFields(err),
          );
          return 'failed';
        },
      ),
    all: (provider) =>
      withEmbedLock(on, async (turn) => {
        const identity = provider.id;
        if (await turn.step({ kind: 'reindex', providerId: identity })) {
          return rebuildIndexForProvider(turn, provider);
        }

        await turn.step({ kind: 'prune' });
        const { count, backfillError } = await backfillAllPending(
          turn,
          provider,
          embeddingIndexIdentity(identity),
        );

        await turn.step({ kind: 'saveModel', providerId: identity });

        if (backfillError) throw backfillError;
        return count;
      }),
  };
}

async function embedMemoryLocked(
  on: IndexTurn,
  provider: EmbeddingProvider,
  entry: MemoryEntry,
): Promise<EmbedOutcome> {
  const { step } = on;
  try {
    const identity = provider.id;
    if (await step({ kind: 'reindex', providerId: identity })) {
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
    warnEmbedFailureOnce(on.failureNotices, provider.kind, errorMessage(err), err);
    return 'failed';
  }
}

async function rebuildIndexForProvider(
  on: IndexTurn,
  provider: EmbeddingProvider,
): Promise<number> {
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

async function backfillPending(
  { rows, step }: IndexTurn,
  provider: EmbeddingProvider,
  pending: readonly string[],
  model: string,
): Promise<{ count: number; backfillError: unknown }> {
  let count = 0;
  let backfillError: unknown = undefined;
  for await (const chunk of entryPages(rows, pending)) {
    let vectors: number[][];
    try {
      vectors = await provider.embed(
        chunk.map((e) => embeddingInputText(e)),
        'passage',
      );
    } catch (err) {
      backfillError = err;
      break;
    }
    count += await step({ kind: 'save', rows: embeddedRows(chunk, vectors), model });
  }
  return { count, backfillError };
}

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
