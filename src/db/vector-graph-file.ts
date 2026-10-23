// A store's vector graph saved beside hippo.db, so a process with no store worker searches a graph instead of
// scanning. Node records have one size and sit in rowid order, so a search reads only the records it reaches.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeFileAtomic } from '../host/atomic-write.js';
import { isJsonObject, isJsonString, tryParseJson } from '../base/util/json.js';
import { errorCode, errorFields, log } from '../base/util/log.js';
import { getHippoDbPath } from './connect.js';
import type { GraphRows } from './vector-graph-rows.js';

// 'HVGF' read as a little-endian u32.
const MAGIC = 0x46475648;
const VERSION = 1;
const HEADER_BYTES = 64;
// rowid f64, id hash u32, level u8, flags u8, layer-0 link count u16, upper-links offset u32.
const RECORD_HEAD = 20;
const FLAG_REPLACED = 1;
const ENCODE_TURN_NODES = 1024;

export function graphFilePath(hippoRoot: string, dim: number): string {
  return path.join(hippoRoot, `vector-graph-${dim}.bin`);
}

/** FNV-1a over the id's UTF-16 units: the intact walk compares a row's memory id with its node's by this. */
export function idHash(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

const align = (n: number, to: number): number => Math.ceil(n / to) * to;
const recordBytesOf = (dim: number, m: number): number => align(RECORD_HEAD + 8 * m + dim, 4);
const upperLevelBytes = (m: number): number => 4 + 4 * m;

/** What a file covers, read from its header. */
export interface GraphStamp {
  readonly model: string;
  readonly dim: number;
  readonly m: number;
  readonly nodes: number;
  readonly entry: number;
  readonly maxLevel: number;
  /** The highest rowid a node holds. */
  readonly highRowid: number;
  /** Nodes not replaced when the file was saved. */
  readonly live: number;
  readonly recordsAt: number;
  readonly recordBytes: number;
  readonly upperAt: number;
  readonly upperBytes: number;
}

/** The nodes in file order, and the file index of each node. */
interface FileOrder {
  readonly order: number[];
  readonly at: Int32Array;
}

/** Nodes in rowid order, so a row's node is found by a binary search; the newest node of a reused rowid stays. */
function fileOrder(rows: GraphRows): FileOrder {
  const order = rows.ids.map((_, node) => node).sort((a, b) => rows.rowids[a] - rows.rowids[b] || a - b);
  const at = new Int32Array(order.length);
  order.forEach((node, i) => {
    at[node] = i;
  });
  return { order, at };
}

// A per-vector scale: the walk scores by cosine, which no scale changes.
function putInt8(unit: Float32Array, out: Int8Array): void {
  let max = 0;
  for (let i = 0; i < unit.length; i++) max = Math.max(max, Math.abs(unit[i]));
  const scale = max > 0 ? 127 / max : 0;
  for (let i = 0; i < unit.length; i++) out[i] = Math.round(unit[i] * scale);
}

/** The file's bytes for `rows`, yielding every ENCODE_TURN_NODES nodes so the caller can give a turn back. */
export function* encodeGraphFile(rows: GraphRows): Generator<void, Uint8Array> {
  const { graph, ids, rowids, nodeOf } = rows;
  const { dim, m } = graph;
  const { order, at } = fileOrder(rows);
  const upperOf = new Uint32Array(order.length);
  let upperBytes = 0;
  for (const node of order) {
    upperOf[node] = upperBytes;
    upperBytes += (graph.nodes.get(node)?.level ?? 0) * upperLevelBytes(m);
  }
  const json = Buffer.from(JSON.stringify({ model: rows.model }), 'utf8');
  const recordBytes = recordBytesOf(dim, m);
  const recordsAt = align(HEADER_BYTES + json.length, 8);
  const upperAt = recordsAt + order.length * recordBytes;
  const bytes = new Uint8Array(upperAt + upperBytes);
  const view = new DataView(bytes.buffer);
  const header = [MAGIC, VERSION, dim, m, order.length, at[graph.entry], graph.maxLevel, json.length];
  header.forEach((value, i) => view.setUint32(i * 4, value, true));
  view.setFloat64(32, rowids[order[order.length - 1]], true);
  view.setUint32(44, recordBytes, true);
  view.setUint32(48, upperBytes, true);
  bytes.set(json, HEADER_BYTES);
  let live = 0;
  for (let i = 0; i < order.length; i++) {
    const node = order[i];
    const data = graph.nodes.get(node);
    const unit = graph.unit.get(node);
    if (!data || !unit) throw new Error(`vector graph file: node ${node} has no record`);
    const reused = i + 1 < order.length && rowids[order[i + 1]] === rowids[node];
    const replaced = reused || nodeOf.get(ids[node]) !== node;
    if (!replaced) live++;
    const off = recordsAt + i * recordBytes;
    view.setFloat64(off, rowids[node], true);
    view.setUint32(off + 8, idHash(ids[node]), true);
    bytes[off + 12] = data.level;
    bytes[off + 13] = replaced ? FLAG_REPLACED : 0;
    view.setUint16(off + 14, data.links[0].length, true);
    view.setUint32(off + 16, upperOf[node], true);
    data.links[0].forEach((to, j) => view.setUint32(off + RECORD_HEAD + 4 * j, at[to], true));
    putInt8(unit, new Int8Array(bytes.buffer, off + RECORD_HEAD + 8 * m, dim));
    for (let level = 1; level <= data.level; level++) {
      const base = upperAt + upperOf[node] + (level - 1) * upperLevelBytes(m);
      view.setUint32(base, data.links[level].length, true);
      data.links[level].forEach((to, j) => view.setUint32(base + 4 + 4 * j, at[to], true));
    }
    if (i % ENCODE_TURN_NODES === ENCODE_TURN_NODES - 1) yield;
  }
  view.setUint32(40, live, true);
  return bytes;
}

/** Saves `bytes` as the graph file of length `dim` with hippo.db's mode bits; false, with one info line, when another
 * process holds the old file open, so a later save tries again. */
export function saveGraphFile(hippoRoot: string, dim: number, bytes: Uint8Array): boolean {
  const file = graphFilePath(hippoRoot, dim);
  const mode = fs.statSync(getHippoDbPath(hippoRoot)).mode & 0o777;
  try {
    writeFileAtomic(file, bytes, { durable: false, mode, inPlace: false });
    return true;
  } catch (err) {
    const code = errorCode(err);
    if (code !== 'EPERM' && code !== 'EBUSY') throw err;
    log.info(`${path.basename(file)} is open in another process (${code}), so the vector graph was not saved`, {
      hippoRoot,
      ...errorFields(err),
    });
    return false;
  }
}

/** A file that cannot be trusted: short, a bad stamp, or a value out of its bounds. The read scans instead. */
export class GraphFileError extends Error {
  override readonly name = 'GraphFileError';
}

export function badGraphFile(file: string, what: string, cause?: unknown): GraphFileError {
  return new GraphFileError(`${path.basename(file)}: ${what}`, cause === undefined ? undefined : { cause });
}

/** Reads and checks the header of the file open on `fd`; throws GraphFileError on anything it cannot trust. */
export function readStamp(fd: number, file: string, size: number): GraphStamp {
  const head = Buffer.alloc(HEADER_BYTES);
  if (size < HEADER_BYTES || fs.readSync(fd, head, 0, HEADER_BYTES, 0) < HEADER_BYTES) {
    throw badGraphFile(file, 'short file');
  }
  const u32 = (at: number): number => head.readUInt32LE(at);
  if (u32(0) !== MAGIC || u32(4) !== VERSION) throw badGraphFile(file, 'not a version 1 vector graph file');
  const [dim, m, nodes, entry, maxLevel, jsonBytes] = [8, 12, 16, 20, 24, 28].map(u32);
  const [live, recordBytes, upperBytes] = [40, 44, 48].map(u32);
  const highRowid = head.readDoubleLE(32);
  const recordsAt = align(HEADER_BYTES + jsonBytes, 8);
  const upperAt = recordsAt + nodes * recordBytes;
  const fits =
    dim >= 1 &&
    m >= 2 &&
    m <= 255 &&
    nodes >= 1 &&
    entry < nodes &&
    maxLevel <= 15 &&
    live <= nodes &&
    recordBytes === recordBytesOf(dim, m) &&
    Number.isSafeInteger(highRowid) &&
    highRowid >= 1;
  if (!fits) throw badGraphFile(file, 'a header value is out of bounds');
  if (upperAt + upperBytes > size) throw badGraphFile(file, 'short file');
  if (upperAt + upperBytes < size) throw badGraphFile(file, 'the file runs on past its last record');
  const json = Buffer.alloc(jsonBytes);
  if (fs.readSync(fd, json, 0, jsonBytes, HEADER_BYTES) < jsonBytes) throw badGraphFile(file, 'short file');
  const stamp = tryParseJson(json.toString('utf8'));
  const model = isJsonObject(stamp) ? stamp.model : undefined;
  if (!isJsonString(model)) throw badGraphFile(file, 'the stamp names no model');
  return { model, dim, m, nodes, entry, maxLevel, highRowid, live, recordsAt, recordBytes, upperAt, upperBytes };
}

export const isReplaced = (flags: number): boolean => (flags & FLAG_REPLACED) !== 0;
export { RECORD_HEAD, upperLevelBytes };
