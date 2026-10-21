// The HNSW graphs of one store's vectors, one per vector length, held by the store worker thread that answers its
// nearest-row reads. Built off the request path; until a graph is ready, and whenever it falls behind, reads scan.
import { DEFAULT_CONFIG } from '../base/config/config.js';
import { errorFields, log } from '../base/util/log.js';
import { requestScopes } from '../base/util/request-scope.js';
import { openHippoDbReadOnly } from './open.js';
import type { DatabaseSyncLike } from './sqlite.js';
import {
  addRow,
  catchUp,
  emptyGraphRows,
  type GraphRows,
  graphMatches,
  ROWS_ABOVE_SQL,
  StagedRows,
  staleNodes,
  type StoredRow,
  storedModel,
} from './vector-graph-rows.js';
import type { VectorIndex, VectorMatch } from './vector-store.js';
import { cachedStatement } from './statement-cache.js';

// The graph beat the paged scan at both p50 and p95 from 1,000 vectors on; docs/ARCHITECTURE.md has the bench.
/** Stored vectors a store holds before its nearest-row reads search a graph. */
const VECTOR_GRAPH_THRESHOLD = 1_000;

// Longest a build holds the thread before a waiting job may run.
const SLICE_MS = 10;
// New rows one query inserts itself; past this the graph catches up in the background and queries scan meanwhile.
const INLINE_ROWS = 32;
// Refreshes between two counts of the stored rows, the only read that sees a deleted vector.
const RECOUNT_EVERY = 256;
const STALE_SHARE = 0.1;
// A build that failed is not tried again for this long, so a broken store logs once a minute, not once a query.
const RETRY_MS = 60_000;

export interface VectorGraphsOptions {
  /** Stored vectors before reads use a graph; VECTOR_GRAPH_THRESHOLD when omitted. */
  readonly threshold?: number | undefined;
  /** Stored vectors past which no graph is kept and reads scan; the config default when omitted. */
  readonly maxVectors?: number | undefined;
}

interface Ready {
  readonly kind: 'ready';
  readonly rows: GraphRows;
  /** The connection and data_version the graph was last brought up to date on; versions of two connections differ. */
  seenOn: DatabaseSyncLike | undefined;
  dataVersion: number;
  refreshes: number;
}

type Slot =
  | Ready
  | { readonly kind: 'building'; readonly done: Promise<void> }
  | { readonly kind: 'failed'; readonly at: number };

function nextTurn(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function dataVersion(db: DatabaseSyncLike): number {
  // SAFETY: PRAGMA data_version always answers one row.
  return (cachedStatement(db, 'PRAGMA data_version').get() as { data_version: number }).data_version;
}

// max(rowid) is one lookup and bounds the row count from above, so a store far under the threshold is never counted.
function storedCount(db: DatabaseSyncLike, threshold: number): number {
  // SAFETY: an aggregate with no GROUP BY always answers one row.
  const top = (cachedStatement(db, 'SELECT max(rowid) AS n FROM memory_vectors').get() as { n: number | null }).n ?? 0;
  if (top < threshold) return top;
  // SAFETY: an aggregate with no GROUP BY always answers one row.
  return (cachedStatement(db, 'SELECT count(*) AS n FROM memory_vectors').get() as { n: number }).n;
}

/** True when the store on `db` holds enough vectors, and not more than `maxVectors`, for a served store's reads to
 * search a graph rather than scan. */
export function graphServesStore(db: DatabaseSyncLike, maxVectors: number): boolean {
  const stored = storedCount(db, VECTOR_GRAPH_THRESHOLD);
  return stored >= VECTOR_GRAPH_THRESHOLD && stored <= maxVectors;
}

/** A thread's graphs of the store under one hippo root. */
export class VectorGraphs implements VectorIndex {
  readonly #hippoRoot: string;
  readonly #threshold: number;
  readonly #maxVectors: number;
  readonly #slots = new Map<number, Slot>();
  #closed = false;
  // Counted under the threshold or over the cap on this connection at this data_version, so not counted again until a
  // write.
  #unfit: { db: DatabaseSyncLike; version: number } | undefined;
  // Set once the over-cap line is logged, so a store that stays over the cap logs it once.
  #overCap = false;

  constructor(hippoRoot: string, opts: VectorGraphsOptions = {}) {
    this.#hippoRoot = hippoRoot;
    this.#threshold = opts.threshold ?? VECTOR_GRAPH_THRESHOLD;
    this.#maxVectors = opts.maxVectors ?? DEFAULT_CONFIG.vectorGraph.maxVectors;
  }

  matches(
    db: DatabaseSyncLike,
    query: readonly number[],
    k: number,
    where: string,
    params: readonly (string | number)[],
  ): VectorMatch[] | undefined {
    const dim = query.length;
    const slot = this.#slots.get(dim);
    if (slot?.kind !== 'ready') {
      if (this.#mayBuild(db, slot)) this.#start(dim, undefined, 0);
      return undefined;
    }
    if (!this.#refresh(db, dim, slot)) return undefined;
    return graphMatches(db, slot.rows, { query, k, where, params });
  }

  /** Stops every build at its next turn; each closes its own connection as it stops. */
  close(): void {
    this.#closed = true;
  }

  /** Settles once no build runs, so the thread closes its store with no build's connection left open. */
  async idle(): Promise<void> {
    await Promise.all([...this.#slots.values()].flatMap((slot) => (slot.kind === 'building' ? [slot.done] : [])));
  }

  #mayBuild(db: DatabaseSyncLike, slot: Slot | undefined): boolean {
    if (this.#closed || slot?.kind === 'building') return false;
    if (slot?.kind === 'failed' && Date.now() - slot.at < RETRY_MS) return false;
    const version = dataVersion(db);
    if (this.#unfit?.db === db && this.#unfit.version === version) return false;
    const stored = storedCount(db, this.#threshold);
    // Under the threshold the count is only a bound from max(rowid), so the cap is not checked against it.
    const fits = stored >= this.#threshold && this.#underCap(stored);
    this.#unfit = fits ? undefined : { db, version };
    return fits;
  }

  // False, after one warn line per crossing, while the store holds more vectors than a graph may.
  #underCap(stored: number): boolean {
    const over = stored > this.#maxVectors;
    if (over && !this.#overCap) {
      log.warn(
        `the store holds ${stored} vectors, over the vector graph cap of ${this.#maxVectors} ` +
          `(vectorGraph.maxVectors), so nearest-row reads scan`,
        { hippoRoot: this.#hippoRoot, vectors: stored, maxVectors: this.#maxVectors },
      );
    }
    this.#overCap = over;
    return !over;
  }

  // True when the graph matches the store as this connection sees it; false sends the query to the scan.
  #refresh(db: DatabaseSyncLike, dim: number, slot: Ready): boolean {
    const version = dataVersion(db);
    if (slot.seenOn === db && slot.dataVersion === version) return true;
    const outcome = catchUp(db, slot.rows, INLINE_ROWS);
    if (outcome.kind === 'lost') {
      this.#slots.delete(dim);
      return false;
    }
    if (outcome.kind === 'behind') {
      this.#start(dim, slot.rows, outcome.afterRowid);
      return false;
    }
    slot.seenOn = db;
    slot.dataVersion = version;
    if (++slot.refreshes % RECOUNT_EVERY === 0) {
      // SAFETY: an aggregate with no GROUP BY always answers one row.
      slot.rows.live = (cachedStatement(db, 'SELECT count(*) AS n FROM memory_vectors').get() as { n: number }).n;
    }
    if (!this.#underCap(slot.rows.live)) {
      this.#slots.delete(dim);
      return false;
    }
    if (staleNodes(slot.rows) <= STALE_SHARE * slot.rows.ids.length) return true;
    // Dropped, so the next read builds a fresh graph without the stale nodes.
    this.#slots.delete(dim);
    return false;
  }

  // Outside the request scope of the read that started it, so its log lines carry no request's id.
  #start(dim: number, base: GraphRows | undefined, afterRowid: number): void {
    const started = Date.now();
    const done = requestScopes
      .exit(() => this.#grow(dim, base, afterRowid))
      .then((rows) => {
        if (rows === undefined) {
          this.#slots.delete(dim);
          return;
        }
        this.#slots.set(dim, { kind: 'ready', rows, seenOn: undefined, dataVersion: 0, refreshes: 0 });
        log.info(`the vector graph of ${rows.ids.length} vectors of length ${dim} is ready`, {
          hippoRoot: this.#hippoRoot,
          buildMs: Date.now() - started,
        });
      })
      .catch(<E>(err: E) => {
        this.#slots.set(dim, { kind: 'failed', at: Date.now() });
        log.warn(`the vector graph of length ${dim} could not be built, so nearest-row reads scan`, {
          hippoRoot: this.#hippoRoot,
          ...errorFields(err),
        });
      });
    this.#slots.set(dim, { kind: 'building', done });
  }

  // Undefined when the threads close first or the vectors now come from another model, so the next read starts over.
  async #grow(dim: number, base: GraphRows | undefined, afterRowid: number): Promise<GraphRows | undefined> {
    await nextTurn();
    const read = await this.#readRows(dim, afterRowid);
    if (read === undefined || (base !== undefined && read.model !== base.model)) return undefined;
    const rows = base ?? emptyGraphRows(dim, read.model);
    // Rows above it that the graph already holds are skipped as they come round again.
    rows.lastRowid = afterRowid;
    let slice = performance.now();
    for (let i = 0; i < read.staged.length; i++) {
      if (performance.now() - slice >= SLICE_MS) {
        await nextTurn();
        if (this.#closed) return undefined;
        slice = performance.now();
      }
      addRow(rows, read.staged.rowids[i], read.staged.ids[i], read.staged.vector(i));
    }
    return rows;
  }

  // A connection of the build's own: its cursor stays open across turns, and jobs on the thread's connection must never
  // read through that snapshot.
  async #readRows(dim: number, afterRowid: number): Promise<{ model: string; staged: StagedRows } | undefined> {
    const db = openHippoDbReadOnly(this.#hippoRoot);
    try {
      // Before the rows: a model change between the two reads then shows as a mismatch at the next query.
      const model = storedModel(db);
      const staged = new StagedRows(dim);
      let slice = performance.now();
      for (const row of db.prepare(ROWS_ABOVE_SQL).iterate(afterRowid, dim) as Iterable<StoredRow>) {
        staged.add(row);
        if (performance.now() - slice < SLICE_MS) continue;
        await nextTurn();
        if (this.#closed) return undefined;
        slice = performance.now();
      }
      return { model, staged };
    } finally {
      db.close();
    }
  }
}
