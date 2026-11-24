import type { DatabaseSyncLike } from './sqlite.js';
import { ZERO_NORM, cosineToQuery, norm } from '../base/rank/cosine.js';
import { cachedStatement } from './statement-cache.js';
import { decodeVector } from './vector-store.js';

export interface VectorMatch {
  id: string;
  score: number;
}

/** A stored vector, decoded. */
export interface VectorRow {
  readonly id: string;
  readonly vector: Float32Array;
}

/**
 * The `k` rows closest to `query` by cosine, best first; ties go to the smaller id, so row order
 * never changes the top k. The query rounds to Float32 as stored vectors are, and scores add up in
 * float64, so every store that feeds it the same bytes ranks alike.
 */
export function rankVectorRows(
  query: readonly number[],
  rows: Iterable<VectorRow>,
  k: number,
): VectorMatch[] {
  const best = bestMatches(query, k);
  if (!best) return [];
  for (const { id, vector } of rows) best.offer(id, vector);
  return best.top();
}

interface BestMatches {
  top(): VectorMatch[];
  offer(id: string, v: Float32Array): void;
  seed(match: VectorMatch): void;
  oneEachId(): void;
}

function bestMatches(query: readonly number[], k: number): BestMatches | null {
  if (k <= 0 || query.length === 0) return null;
  const q = Float32Array.from(query);
  const qNorm = norm(q);
  if (qNorm < ZERO_NORM) return null;
  const kept = new MatchHeap(k);
  return {
    top: () => kept.sorted(),
    seed: (match) => kept.offer(match),
    oneEachId: () => kept.oneEachId(),
    offer(id, v) {
      if (v.length !== q.length) return;
      const score = cosineToQuery(q, qNorm, v);
      if (score !== null) kept.offer({ id, score });
    },
  };
}

class MatchHeap {
  readonly #k: number;
  readonly #heap: VectorMatch[] = [];
  #at: Map<string, number> | undefined;

  constructor(k: number) {
    this.#k = k;
  }

  oneEachId(): void {
    this.#at = new Map(this.#heap.map((m, i) => [m.id, i]));
  }

  offer(m: VectorMatch): void {
    const heap = this.#heap;
    const held = this.#at?.get(m.id);
    if (held !== undefined) {
      heap[held] = m;
      this.#siftDown(this.#siftUp(held));
    } else if (heap.length < this.#k) {
      heap.push(m);
      this.#at?.set(m.id, heap.length - 1);
      this.#siftUp(heap.length - 1);
    } else if (beats(m.score, m.id, heap[0])) {
      this.#at?.delete(heap[0].id);
      heap[0] = m;
      this.#at?.set(m.id, 0);
      this.#siftDown(0);
    }
  }

  sorted(): VectorMatch[] {
    return [...this.#heap].sort((a, b) =>
      beats(a.score, a.id, b) ? -1 : beats(b.score, b.id, a) ? 1 : 0,
    );
  }

  #worse(i: number, j: number): boolean {
    return beats(this.#heap[j].score, this.#heap[j].id, this.#heap[i]);
  }

  #swap(i: number, j: number): void {
    const heap = this.#heap;
    [heap[i], heap[j]] = [heap[j], heap[i]];
    this.#at?.set(heap[i].id, i);
    this.#at?.set(heap[j].id, j);
  }

  #siftUp(i: number): number {
    for (
      let parent = (i - 1) >> 1;
      i > 0 && this.#worse(i, parent);
      i = parent, parent = (i - 1) >> 1
    ) {
      this.#swap(i, parent);
    }
    return i;
  }

  #siftDown(i: number): void {
    for (;;) {
      const left = 2 * i + 1;
      let worst = i;
      if (left < this.#heap.length && this.#worse(left, worst)) worst = left;
      if (left + 1 < this.#heap.length && this.#worse(left + 1, worst)) worst = left + 1;
      if (worst === i) return;
      this.#swap(i, worst);
      i = worst;
    }
  }
}

const VECTOR_SCAN_PAGE = 1024;

function nextTurn(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** An index's nearest admitted rows among those at or below `coveredRowid`; the caller scores
 * the rows above it. */
export interface ProposedMatches {
  readonly matches: readonly VectorMatch[];
  readonly coveredRowid: number;
}

/** Proposes a query's nearest rows from a graph; undefined when it cannot answer, so the caller
 * scans. */
export interface VectorIndex {
  matches(db: DatabaseSyncLike, ask: VectorMatchQuery): ProposedMatches | undefined;
}

/** The admitted vectors of length `?` among `memories m` rows passing `where`, narrowed by
 * `among` (SQL ending in AND, bound first). The scan and the graphs' reads share it, so a graph
 * can never admit a row the scan would not. */
export function admittedVectorsSql(where: string, among = ''): string {
  // CROSS JOIN keeps memory_vectors the outer loop, so a page walks its key in order instead of
  // sorting every row.
  return `SELECT v.rowid AS rowid, v.memory_id AS id, v.vector AS vector
    FROM memory_vectors v CROSS JOIN memories m ON m.id = v.memory_id
    WHERE ${among}v.dim = ?${where}`;
}

/** What the nearest-vector reads ask: `k` rows closest to `query` among `memories m` rows
 * passing `where`. */
export interface VectorMatchQuery {
  query: readonly number[];
  k: number;
  where: string;
  params: readonly (string | number)[];
}

export interface TopVectorMatchesOptions extends VectorMatchQuery {
  index?: VectorIndex;
}

/** The `k` stored vectors closest to `query` among `memories m` rows passing `where` (SQL starting with ` AND`).
 *  Filters run before the cut, so rows a caller may not see can never push admitted rows out of the top k. */
export async function topVectorMatches(
  db: DatabaseSyncLike,
  options: TopVectorMatchesOptions,
): Promise<VectorMatch[]> {
  const { query, k, where, params, index } = options;
  const best = bestMatches(query, k);
  if (!best) return [];
  const proposed = index?.matches(db, { query, k, where, params });
  if (proposed === undefined) return offerPages(db, best, options, { key: 'memory_id', after: '' });
  for (const match of proposed.matches) best.seed(match);
  best.oneEachId();
  return offerPages(db, best, options, { key: 'rowid', after: proposed.coveredRowid });
}

async function offerPages(
  db: DatabaseSyncLike,
  best: BestMatches,
  { query, where, params }: VectorMatchQuery,
  from: { readonly key: 'memory_id' | 'rowid'; readonly after: string | number },
): Promise<VectorMatch[]> {
  const page = cachedStatement(
    db,
    `${admittedVectorsSql(where)} AND v.${from.key} > ? ORDER BY v.${from.key} LIMIT ?`,
  );
  const floats = new Float32Array(query.length);
  const bytes = new Uint8Array(floats.buffer);
  let after = from.after;
  for (;;) {
    // SAFETY: node:sqlite returns BLOBs as Uint8Array.
    const rows = page.all(query.length, ...params, after, VECTOR_SCAN_PAGE) as Array<{
      rowid: number;
      id: string;
      vector: Uint8Array;
    }>;
    for (const row of rows) {
      if (row.vector.byteLength === bytes.byteLength) {
        bytes.set(row.vector);
        best.offer(row.id, floats);
      } else {
        best.offer(row.id, decodeVector(row.vector));
      }
    }
    if (rows.length < VECTOR_SCAN_PAGE) return best.top();
    const last = rows[rows.length - 1];
    after = from.key === 'rowid' ? last.rowid : last.id;
    await nextTurn();
  }
}

function beats(score: number, id: string, other: VectorMatch): boolean {
  return score > other.score || (score === other.score && id < other.id);
}
