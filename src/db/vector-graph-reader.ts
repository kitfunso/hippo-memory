// A store's saved vector graph as a VectorIndex. Each read takes the whole file in one call and closes it at once, so a
// writer on Windows can replace the file between reads; a record a time cost a syscall for each node the walk reached.
import * as fs from 'node:fs';
import { errorCode, errorFields, log } from '../base/util/log.js';
import type { DatabaseSyncLike } from './sqlite.js';
import { cachedStatement } from './statement-cache.js';
import { searchView, type GraphView } from './vector-graph.js';
import {
  badGraphFile,
  GraphFileError,
  graphFilePath,
  idHash,
  isReplaced,
  RECORD_HEAD,
  readStamp,
  type GraphStamp,
  upperLevelBytes,
} from './vector-graph-file.js';
import { admittedRows, proposedMatches, STALE_SHARE, storedModel } from './vector-graph-rows.js';
import type { ProposedMatches, VectorIndex, VectorMatch, VectorMatchQuery } from './vector-store.js';

// Rows below the file's newest that may be checked for the newest row still holding what the file read.
const INTACT_WALK = 32;

interface NodeRecord {
  readonly rowid: number;
  readonly idHash: number;
  readonly level: number;
  readonly replaced: boolean;
  readonly links: Uint32Array;
  readonly vector: Float32Array;
  readonly upperOffset: number;
}

/** One graph file's bytes, decoded a record at a time as a search reaches each node; each value is checked as it is
 * read, so a bad one throws GraphFileError and never steers a read out of the file. */
class GraphFileView implements GraphView {
  readonly #bytes: Buffer;
  readonly #file: string;
  readonly stamp: GraphStamp;
  readonly #records = new Map<number, NodeRecord>();
  readonly #upper = new Map<number, Uint32Array>();

  private constructor(bytes: Buffer, file: string, stamp: GraphStamp) {
    this.#bytes = bytes;
    this.#file = file;
    this.stamp = stamp;
  }

  /** Undefined when there is no file; throws GraphFileError when it cannot be read or trusted. */
  static open(file: string): GraphFileView | undefined {
    let fd: number;
    try {
      fd = fs.openSync(file, 'r');
    } catch (err) {
      if (errorCode(err) === 'ENOENT') return undefined;
      throw badGraphFile(file, 'could not be opened', err);
    }
    try {
      const size = fs.fstatSync(fd).size;
      const stamp = readStamp(fd, file, size);
      const bytes = Buffer.allocUnsafe(size);
      for (let got = 0; got < size;) {
        const read = fs.readSync(fd, bytes, got, size - got, got);
        if (read === 0) throw badGraphFile(file, 'short file');
        got += read;
      }
      return new GraphFileView(bytes, file, stamp);
    } catch (err) {
      throw err instanceof GraphFileError ? err : badGraphFile(file, 'could not be read', err);
    } finally {
      fs.closeSync(fd);
    }
  }

  get dim(): number {
    return this.stamp.dim;
  }

  get entry(): number {
    return this.stamp.entry;
  }

  get maxLevel(): number {
    return this.stamp.maxLevel;
  }

  record(node: number): NodeRecord {
    const known = this.#records.get(node);
    if (known) return known;
    const { nodes, recordsAt, recordBytes, highRowid, maxLevel, m, dim, upperBytes } = this.stamp;
    if (!Number.isInteger(node) || node < 0 || node >= nodes) throw this.#bad(`node ${node} is out of range`);
    const buf = this.#read(recordsAt + node * recordBytes, recordBytes);
    const rowid = buf.readDoubleLE(0);
    const [level, flags, count, upperOffset] = [buf[12], buf[13], buf.readUInt16LE(14), buf.readUInt32LE(16)];
    const upperFits = level === 0 || (upperOffset % 4 === 0 && upperOffset + level * upperLevelBytes(m) <= upperBytes);
    const fits = Number.isSafeInteger(rowid) && rowid >= 1 && rowid <= highRowid && level <= maxLevel && flags <= 1;
    if (!fits || count > 2 * m || !upperFits) throw this.#bad(`node ${node} has a value out of bounds`);
    const record: NodeRecord = {
      rowid,
      idHash: buf.readUInt32LE(8),
      level,
      replaced: isReplaced(flags),
      links: this.#links(buf, RECORD_HEAD, count, node),
      vector: new Float32Array(new Int8Array(buf.buffer, buf.byteOffset + RECORD_HEAD + 8 * m, dim)),
      upperOffset,
    };
    this.#records.set(node, record);
    return record;
  }

  linksOf(node: number, level: number): ArrayLike<number> {
    const record = this.record(node);
    if (level === 0) return record.links;
    if (level > record.level) throw this.#bad(`node ${node} is linked at level ${level}, above its own`);
    const key = node * 16 + level;
    const known = this.#upper.get(key);
    if (known) return known;
    const { upperAt, m } = this.stamp;
    const buf = this.#read(upperAt + record.upperOffset + (level - 1) * upperLevelBytes(m), upperLevelBytes(m));
    const count = buf.readUInt32LE(0);
    if (count > m) throw this.#bad(`node ${node} has ${count} links at level ${level}`);
    const links = this.#links(buf, 4, count, node);
    this.#upper.set(key, links);
    return links;
  }

  /** The node at `rowid`: records sit in rowid order, and of a reused rowid only the last is current. */
  nodeAt(rowid: number): number | undefined {
    let lo = 0;
    let hi = this.stamp.nodes;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.record(mid).rowid <= rowid) lo = mid + 1;
      else hi = mid;
    }
    return lo > 0 && this.record(lo - 1).rowid === rowid ? lo - 1 : undefined;
  }

  #links(buf: Buffer, at: number, count: number, node: number): Uint32Array {
    const links = new Uint32Array(count);
    for (let j = 0; j < count; j++) {
      links[j] = buf.readUInt32LE(at + 4 * j);
      if (links[j] >= this.stamp.nodes) throw this.#bad(`node ${node} links to node ${links[j]}, out of range`);
    }
    return links;
  }

  #read(at: number, length: number): Buffer {
    if (at + length > this.#bytes.length) throw this.#bad('short file');
    return this.#bytes.subarray(at, at + length);
  }

  #bad(what: string): GraphFileError {
    return badGraphFile(this.#file, what);
  }
}

/** How the file stands against the store: the rowid it still answers for, the rows above it and its stale nodes. */
interface Coverage {
  readonly rowid: number;
  readonly above: number;
  readonly stale: number;
}

function countOf(db: DatabaseSyncLike, sql: string, ...params: number[]): number {
  // SAFETY: an aggregate with no GROUP BY always answers one row.
  return (cachedStatement(db, sql).get(...params) as { n: number }).n;
}

/** The highest rowid at or below the file's newest whose row still holds the memory its node read, or undefined when
 * none of the newest rows does. SQLite hands a deleted top rowid out again, so rows above it may be new. */
function intactRowid(db: DatabaseSyncLike, file: GraphFileView): number | undefined {
  const rows = cachedStatement(
    db,
    'SELECT rowid AS rowid, memory_id AS id FROM memory_vectors WHERE rowid <= ? ORDER BY rowid DESC LIMIT ?',
  ).all(file.stamp.highRowid, INTACT_WALK) as Array<{ rowid: number; id: string }>;
  for (const row of rows) {
    const node = file.nodeAt(row.rowid);
    const record = node === undefined ? undefined : file.record(node);
    if (record && !record.replaced && record.idHash === idHash(row.id)) return row.rowid;
  }
  return undefined;
}

// Undefined when the file is from another model or none of its newest rows is intact.
function coverage(db: DatabaseSyncLike, file: GraphFileView): Coverage | undefined {
  if (file.stamp.model !== storedModel(db)) return undefined;
  const rowid = intactRowid(db, file);
  if (rowid === undefined) return undefined;
  // count(*) walks the memory_id key, the smallest b-tree; rows above the intact one are few, and read anyway.
  const all = countOf(db, 'SELECT count(*) AS n FROM memory_vectors');
  const above = countOf(db, 'SELECT count(*) AS n FROM memory_vectors WHERE rowid > ?', rowid);
  return { rowid, above, stale: Math.max(0, file.stamp.nodes - (all - above)) };
}

function fileMatches(
  db: DatabaseSyncLike,
  file: GraphFileView,
  covered: number,
  { query, k, where, params }: VectorMatchQuery,
): VectorMatch[] | undefined {
  const q = Float32Array.from(query);
  const admit = (node: number): boolean => {
    const record = file.record(node);
    return !record.replaced && record.rowid <= covered;
  };
  const filter = { dim: q.length, where, params };
  return proposedMatches(query, k, {
    nodes: file.stamp.nodes,
    walk: (ef) => searchView(file, q, { k: ef, ef, admit, vectorOf: (node) => file.record(node).vector }),
    admit: (nodes) =>
      admittedRows(
        db,
        'rowid',
        nodes.map((node) => file.record(node).rowid),
        filter,
      ),
  });
}

/** The graph file under one store root, read off the store worker and by a worker whose own graph is not ready. */
export class GraphFileIndex implements VectorIndex {
  readonly #hippoRoot: string;
  // A file that cannot be trusted warns once, until it is replaced.
  readonly #warned = new Set<string>();

  constructor(hippoRoot: string) {
    this.#hippoRoot = hippoRoot;
  }

  matches(
    db: DatabaseSyncLike,
    query: readonly number[],
    k: number,
    where: string,
    params: readonly (string | number)[],
  ): ProposedMatches | undefined {
    return this.#onFile(query.length, (file) => {
      const covered = coverage(db, file);
      if (covered === undefined || covered.stale > STALE_SHARE * file.stamp.nodes) return undefined;
      const matches = fileMatches(db, file, covered.rowid, { query, k, where, params });
      return matches && { matches, coveredRowid: covered.rowid };
    });
  }

  /** The share of the file's nodes that are stale plus the rows above what it covers; Infinity when it has no use. */
  drift(db: DatabaseSyncLike, dim: number): number {
    const share = this.#onFile(dim, (file) => {
      const covered = coverage(db, file);
      return covered && (covered.above + covered.stale) / file.stamp.nodes;
    });
    return share ?? Number.POSITIVE_INFINITY;
  }

  #onFile<T>(dim: number, read: (file: GraphFileView) => T | undefined): T | undefined {
    const path = graphFilePath(this.#hippoRoot, dim);
    try {
      const file = GraphFileView.open(path);
      return file && read(file);
    } catch (err) {
      if (!(err instanceof GraphFileError)) throw err;
      this.#warnOnce(path, err);
      return undefined;
    }
  }

  #warnOnce(path: string, err: GraphFileError): void {
    const stat = fs.statSync(path, { throwIfNoEntry: false });
    const key = `${path}:${stat?.size}:${stat?.mtimeMs}`;
    if (this.#warned.has(key)) return;
    this.#warned.add(key);
    log.warn(`the vector graph file cannot be used, so nearest-row reads scan: ${err.message}`, {
      hippoRoot: this.#hippoRoot,
      ...errorFields(err),
    });
  }
}
