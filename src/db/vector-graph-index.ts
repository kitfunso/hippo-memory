// The HNSW graphs of one store's vectors, one per vector length, held by the store worker thread that answers its
// nearest-row reads. Built off the request path; until a graph is ready, reads search the saved graph file or scan.
import { DEFAULT_CONFIG } from '../base/config/config.js';
import { errorFields, log } from '../base/util/log.js';
import { requestScopes } from '../base/util/request-scope.js';
import { openHippoDbReadOnly } from './open.js';
import type { DatabaseSyncLike } from './sqlite.js';
import { nextTurn, saveGraphIfDrifted, type Turn } from './vector-graph-build.js';
import { GraphFileIndex } from './vector-graph-reader.js';
import {
  addRow,
  catchUp,
  emptyGraphRows,
  type GraphRows,
  graphMatches,
  ROWS_ABOVE_SQL,
  STALE_SHARE,
  StagedRows,
  staleNodes,
  type StoredRow,
  storedModel,
  VECTOR_GRAPH_THRESHOLD,
} from './vector-graph-rows.js';
import type { ProposedMatches, VectorIndex } from './vector-store.js';
import { cachedStatement } from './statement-cache.js';

// Longest a build holds the thread before a waiting job may run.
const SLICE_MS = 10;
// New rows one query inserts itself; past this the graph catches up in the background and answers meanwhile for the
// rows it holds.
const INLINE_ROWS = 32;
// Refreshes between two counts of the stored rows, the only read that sees a deleted vector.
const RECOUNT_EVERY = 256;
// A build that failed is not tried again for this long, so a broken store logs once a minute, not once a query.
const RETRY_MS = 60_000;

export interface VectorGraphsOptions {
  /** Stored vectors before reads use a graph; VECTOR_GRAPH_THRESHOLD when omitted. */
  readonly threshold?: number | undefined;
  /** Stored vectors past which no graph is kept; the config default when omitted. */
  readonly maxVectors?: number | undefined;
}

interface Ready {
  readonly kind: 'ready';
  readonly rows: GraphRows;
  /** The connection and data_version the graph was last brought up to date on; versions of two connections differ. */
  seenOn: DatabaseSyncLike | undefined;
  dataVersion: number;
  refreshes: number;
  /** The rowid a background catch-up reads above; until it ends, reads answer up to it from the graph. */
  catchingUpFrom: number | undefined;
}

type Slot = Ready | { readonly kind: 'building' } | { readonly kind: 'failed'; readonly at: number };

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
  readonly #file: GraphFileIndex;
  // Builds, catch-ups and the saves after them, so the thread closes its store with none left running.
  readonly #work = new Set<Promise<void>>();
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
    this.#file = new GraphFileIndex(hippoRoot);
  }

  matches(
    db: DatabaseSyncLike,
    query: readonly number[],
    k: number,
    where: string,
    params: readonly (string | number)[],
  ): ProposedMatches | undefined {
    const dim = query.length;
    const slot = this.#slots.get(dim);
    if (slot?.kind === 'ready') {
      const covered = this.#covered(db, dim, slot);
      if (covered !== undefined) {
        const matches = graphMatches(db, slot.rows, { query, k, where, params });
        return matches && { matches, coveredRowid: covered };
      }
    } else if (this.#mayBuild(db, slot)) {
      this.#start(dim);
    }
    return this.#file.matches(db, query, k, where, params);
  }

  /** Stops every build at its next turn; each closes its own connection as it stops. */
  close(): void {
    this.#closed = true;
  }

  /** Settles once no build or save runs, so the thread closes its store with no build's connection left open. */
  async idle(): Promise<void> {
    await Promise.all(this.#work);
  }

  readonly #turn: Turn = async () => {
    await nextTurn();
    return !this.#closed;
  };

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
          `(vectorGraph.maxVectors), so no graph is built`,
        { hippoRoot: this.#hippoRoot, vectors: stored, maxVectors: this.#maxVectors },
      );
    }
    this.#overCap = over;
    return !over;
  }

  // The rowid up to which the graph answers for the store as this connection sees it; undefined drops to the file.
  #covered(db: DatabaseSyncLike, dim: number, slot: Ready): number | undefined {
    if (slot.catchingUpFrom !== undefined) {
      return storedModel(db) === slot.rows.model ? slot.catchingUpFrom : undefined;
    }
    const version = dataVersion(db);
    if (slot.seenOn === db && slot.dataVersion === version) return slot.rows.lastRowid;
    const outcome = catchUp(db, slot.rows, INLINE_ROWS);
    if (outcome.kind === 'behind') {
      this.#catchUp(dim, slot, outcome.afterRowid);
      return outcome.afterRowid;
    }
    if (outcome.kind === 'current') {
      slot.seenOn = db;
      slot.dataVersion = version;
      if (++slot.refreshes % RECOUNT_EVERY === 0) {
        // SAFETY: an aggregate with no GROUP BY always answers one row.
        slot.rows.live = (cachedStatement(db, 'SELECT count(*) AS n FROM memory_vectors').get() as { n: number }).n;
      }
      const fresh = staleNodes(slot.rows) <= STALE_SHARE * slot.rows.ids.length;
      if (this.#underCap(slot.rows.live) && fresh) return slot.rows.lastRowid;
    }
    // Dropped, so the next read builds a fresh graph without the stale nodes or the other model's vectors.
    this.#slots.delete(dim);
    return undefined;
  }

  #start(dim: number): void {
    this.#slots.set(dim, { kind: 'building' });
    this.#background(dim, async () => {
      const started = Date.now();
      const rows = await this.#grow(dim, undefined, 0);
      if (rows === undefined) {
        this.#slots.delete(dim);
        return;
      }
      const ready: Ready = {
        kind: 'ready',
        rows,
        seenOn: undefined,
        dataVersion: 0,
        refreshes: 0,
        catchingUpFrom: undefined,
      };
      this.#slots.set(dim, ready);
      this.#ready(rows, started);
      await saveGraphIfDrifted(this.#hippoRoot, rows, this.#turn);
    });
  }

  // The graph keeps answering for the rows up to `afterRowid` while the rows above it are added between turns.
  #catchUp(dim: number, slot: Ready, afterRowid: number): void {
    slot.catchingUpFrom = afterRowid;
    this.#background(dim, async () => {
      const started = Date.now();
      const rows = await this.#grow(dim, slot.rows, afterRowid);
      if (this.#slots.get(dim) !== slot) return;
      if (rows === undefined) {
        this.#slots.delete(dim);
        return;
      }
      slot.catchingUpFrom = undefined;
      slot.seenOn = undefined;
      this.#ready(rows, started);
      await saveGraphIfDrifted(this.#hippoRoot, rows, this.#turn);
    });
  }

  #ready(rows: GraphRows, started: number): void {
    log.info(`the vector graph of ${rows.ids.length} vectors of length ${rows.graph.dim} is ready`, {
      hippoRoot: this.#hippoRoot,
      buildMs: Date.now() - started,
    });
  }

  // Outside the request scope of the read that started it, so its log lines carry no request's id.
  #background(dim: number, task: () => Promise<void>): void {
    const done: Promise<void> = requestScopes
      .exit(task)
      .catch(<E>(err: E) => {
        this.#slots.set(dim, { kind: 'failed', at: Date.now() });
        log.warn(`the vector graph of length ${dim} could not be built, so nearest-row reads scan`, {
          hippoRoot: this.#hippoRoot,
          ...errorFields(err),
        });
      })
      .finally(() => {
        this.#work.delete(done);
      });
    this.#work.add(done);
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
        if (!(await this.#turn())) return undefined;
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
        if (!(await this.#turn())) return undefined;
        slice = performance.now();
      }
      return { model, staged };
    } finally {
      db.close();
    }
  }
}
