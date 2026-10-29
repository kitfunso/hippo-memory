// The mirrors derived from the database: the memory markdown files, the open-conflict files,
// index.json and stats.json, and the sync that rebuilds them. Active-task and recent-session files
// live in session-mirrors.ts.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Layer, type MemoryEntry } from '../../../base/memory/entry.js';
import { dumpFrontmatter } from '../../../base/util/yaml.js';
import { type DatabaseSyncLike, CONSOLIDATION_RUNS_KEPT } from '../../../db/index.js';
import { oncePerStore, type StoreAt } from '../../../db/connect.js';
import { errorFields, errorMessage, log } from '../../../base/util/log.js';
import {
  type HippoIndex,
  type IndexEntry,
  parseJsonArray,
  INDEX_VERSION,
  parseLastTraceId,
  type ConsolidationRunRow,
  MEMORY_SELECT_COLUMNS,
  type MemoryRow,
  rowToEntry,
  MEMORY_CONFLICT_COLUMNS,
} from '../runtime/rows.js';
import type { LegacyStats } from '../../../base/ports/store/reports.js';
import type { ConflictWire } from '../../../base/memory/conflict-wire.js';
import { mirrorDecimal, serializeEntry } from '../../../base/memory/markdown.js';
import { writeFileAtomic } from '../../../host/atomic-write.js';
import { cachedStatement } from '../../../db/statement-cache.js';
import { READ_PAGE_ROWS } from '../../../base/util/pages.js';
import { PRIVATE_DIR } from '../../../host/private-dir.js';
import { META_KEY, getMetaNumber } from '../../../db/meta.js';

const SCORE_DECIMALS = 3;

// Mirrors are derived and rebuildable from the store, so they skip the fsyncs (the cost on Windows)
// and keep the temp-and-rename atomicity.
export function writeMirror(file: string, text: string): void {
  writeFileAtomic(file, text, { durable: false });
}

export function layerDir(root: string, layer: Layer): string {
  return path.join(root, layer);
}

/** Makes the mirror folders on a store's first open in this process; a writer makes its own
 * folder if one goes missing later. */
export function ensureMirrorDirectories(at: StoreAt): void {
  const { hippoRoot } = at;
  oncePerStore(at, 'mirror-folders', () => {
    for (const sub of ['buffer', 'episodic', 'semantic', 'conflicts']) {
      fs.mkdirSync(path.join(hippoRoot, sub), PRIVATE_DIR);
    }
  });
}

const conflictMirrorName = (conflict: ConflictWire): string => `conflict_${conflict.id}.md`;

function writeConflictMirror(conflictDir: string, conflict: ConflictWire): void {
  const fm = dumpFrontmatter({ ...conflict, score: mirrorDecimal(conflict.score) });
  const body = [
    '# Memory Conflict',
    '',
    `- Memory A: ${conflict.memory_a_id}`,
    `- Memory B: ${conflict.memory_b_id}`,
    `- Reason: ${conflict.reason}`,
    `- Score: ${conflict.score.toFixed(SCORE_DECIMALS)}`,
    `- Status: ${conflict.status}`,
    '',
  ].join('\n');
  writeMirror(path.join(conflictDir, conflictMirrorName(conflict)), `${fm}\n\n${body}`);
}

/** Every open conflict's file, and no other: the full sync's rebuild of the folder. */
function writeAllConflictMirrors(hippoRoot: string, open: readonly ConflictWire[]): void {
  const conflictDir = path.join(hippoRoot, 'conflicts');
  fs.mkdirSync(conflictDir, PRIVATE_DIR);
  const keep = new Set(open.map(conflictMirrorName));
  for (const conflict of open) writeConflictMirror(conflictDir, conflict);
  for (const existing of fs.readdirSync(conflictDir)) {
    if (existing !== '.gitkeep' && !keep.has(existing)) {
      fs.unlinkSync(path.join(conflictDir, existing));
    }
  }
}

/** The files of `changed` alone: an open conflict's is rewritten, a closed one's removed. */
function writeChangedConflictMirrors(hippoRoot: string, changed: readonly ConflictWire[]): void {
  if (changed.length === 0) return;
  const conflictDir = path.join(hippoRoot, 'conflicts');
  fs.mkdirSync(conflictDir, PRIVATE_DIR);
  for (const conflict of changed) {
    if (conflict.status === 'open') writeConflictMirror(conflictDir, conflict);
    else fs.rmSync(path.join(conflictDir, conflictMirrorName(conflict)), { force: true });
  }
}

export function writeMarkdownMirror(hippoRoot: string, entry: MemoryEntry): void {
  removeEntryMirrors(hippoRoot, entry.id);
  const dir = layerDir(hippoRoot, entry.layer);
  fs.mkdirSync(dir, PRIVATE_DIR);
  writeMirror(path.join(dir, `${entry.id}.md`), serializeEntry(entry));
}

// Every layer, Trace included: `writeMarkdownMirror` writes any layer, and a stale trace mirror is
// the resurrection channel bootstrapLegacyStore guards against.
const MIRROR_LAYERS = [Layer.Buffer, Layer.Episodic, Layer.Semantic, Layer.Trace] as const;

export function removeEntryMirrors(hippoRoot: string, id: string): void {
  for (const layer of MIRROR_LAYERS) {
    const file = path.join(layerDir(hippoRoot, layer), `${id}.md`);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  }
}

/** A folder the batch writes into is listed once when this many of its entries sit in other
 * layers and would each probe it: a layer folder can hold every mirror in the store. */
const LISTING_MIN_BATCH = 64;

/** The names in each listed layer folder; a layer with no listing is probed file by file. */
type LayerListing = ReadonlyMap<Layer, ReadonlySet<string>>;

/** writeMarkdownMirror for many entries; returns the ids whose file it wrote. A file that fails
 * is warned about and the rest still land. */
export function writeMarkdownMirrors(hippoRoot: string, entries: Iterable<MemoryEntry>): string[] {
  const written: string[] = [];
  mirrorBestEffort('markdown mirrors', () => {
    const listed = listedLayers(hippoRoot, entries);
    const made = new Set<string>();
    for (const entry of entries) {
      try {
        writeListedMirror(hippoRoot, entry, listed, made);
        written.push(entry.id);
      } catch (err) {
        log.warnThenSample(
          'markdown-mirror',
          `${entry.id}.md not refreshed (${errorMessage(err)}); the database write succeeded`,
          errorFields(err),
        );
      }
    }
  });
  return written;
}

/** A stream of every row lists all four folders; a batch lists only folders it writes into that
 * enough of its entries would probe for a copy left in another layer. */
function listedLayers(hippoRoot: string, entries: Iterable<MemoryEntry>): LayerListing {
  let layers: readonly Layer[] = MIRROR_LAYERS;
  if (Array.isArray(entries)) {
    const inLayer = new Map<Layer, number>();
    for (const entry of entries) inLayer.set(entry.layer, (inLayer.get(entry.layer) ?? 0) + 1);
    layers = [...inLayer]
      .filter(([, n]) => entries.length - n >= LISTING_MIN_BATCH)
      .map(([layer]) => layer);
  }
  return new Map(
    layers.map((layer) => {
      const dir = layerDir(hippoRoot, layer);
      return [layer, new Set(fs.existsSync(dir) ? fs.readdirSync(dir) : [])];
    }),
  );
}

/** writeMarkdownMirror against `listed`: a copy in another layer's folder goes, found in its
 * listing or by a probe, and the entry's own file is replaced in place, so no crash leaves it
 * missing; `made` holds the folders already made. */
function writeListedMirror(
  hippoRoot: string,
  entry: MemoryEntry,
  listed: LayerListing,
  made: Set<string>,
): void {
  const name = `${entry.id}.md`;
  for (const layer of MIRROR_LAYERS) {
    if (layer === entry.layer) continue;
    const file = path.join(layerDir(hippoRoot, layer), name);
    if (listed.get(layer)?.has(name) ?? fs.existsSync(file)) fs.rmSync(file, { force: true });
  }
  const dir = layerDir(hippoRoot, entry.layer);
  if (!made.has(dir)) fs.mkdirSync(dir, PRIVATE_DIR);
  made.add(dir);
  writeMirror(path.join(dir, name), serializeEntry(entry));
}

/** Mirror paths for `id` still on disk, walked like `removeEntryMirrors`, so a failed purge with
 * no reaper to retry it can name the stuck file. */
function listEntryMirrorPaths(hippoRoot: string, id: string): string[] {
  return MIRROR_LAYERS.map((layer) => path.join(layerDir(hippoRoot, layer), `${id}.md`)).filter(
    (file) => fs.existsSync(file),
  );
}

/** The memory whose mirror goes, whether it is raw, and the caller's log prefix. */
interface PurgeMirrorOptions {
  readonly id: string;
  readonly isRaw: boolean;
  readonly logPrefix: string;
}

/** Best-effort mirror purge: retries the unlink once (most failures are transient locks); the
 * reaper only scans `raw_archive`, so a non-raw id's second failure logs the leftover path(s) to
 * delete by hand. Returns true if the mirror ended up purged. */
export function purgeMirrorBestEffort(
  hippoRoot: string,
  { id, isRaw, logPrefix }: PurgeMirrorOptions,
): boolean {
  try {
    removeEntryMirrors(hippoRoot, id);
    return true;
  } catch (firstErr) {
    log.debug(
      `${logPrefix}: mirror cleanup for ${id} failed once, retrying: ${errorMessage(firstErr)}`,
      errorFields(firstErr),
    );
    try {
      removeEntryMirrors(hippoRoot, id);
      return true;
    } catch (secondErr) {
      const msg = errorMessage(secondErr);
      if (isRaw) {
        log.error(
          `${logPrefix}: mirror cleanup failed for ${id} (will retry via reaper on next open): ${msg}`,
          errorFields(secondErr),
        );
      } else {
        const leftover = listEntryMirrorPaths(hippoRoot, id);
        const pathsNote = leftover.length > 0 ? leftover.join(', ') : `${id}.md (path unresolved)`;
        log.error(
          `${logPrefix}: mirror cleanup failed for ${id} - no automatic retry exists for this file, ` +
            `delete it manually: ${pathsNote} (${msg})`,
          errorFields(secondErr),
        );
      }
      return false;
    }
  }
}

/** Derive the current `HippoIndex` from SQLite. Exported for the longmemeval benchmark. */
export function buildIndexFromDb(db: DatabaseSyncLike): HippoIndex {
  const rows = cachedStatement(
    db,
    `SELECT id, created, last_retrieved, strength, layer, tags_json, pinned FROM memories ORDER BY created ASC, id ` +
      `ASC`,
  ).all() as Array<{
    id: string;
    created: string;
    last_retrieved: string;
    strength: number;
    layer: string;
    tags_json: string;
    pinned: number;
  }>;

  const entries: Record<string, IndexEntry> = {};
  for (const row of rows) {
    // SAFETY: layer is only ever written from the Layer enum by this module's own INSERT/UPDATE
    // paths.
    const layer = row.layer as Layer;
    entries[row.id] = {
      id: row.id,
      file: path.join(layer, `${row.id}.md`),
      layer,
      strength: Number(row.strength ?? 0),
      tags: parseJsonArray(row.tags_json, { table: 'memories', id: row.id, column: 'tags_json' }),
      created: row.created,
      last_retrieved: row.last_retrieved,
      pinned: Boolean(row.pinned),
    };
  }

  return { version: INDEX_VERSION, entries, ...readLastRecall(db) };
}

/** The last recall's ids and its trace, the two meta keys saveIndex writes together. */
export function readLastRecall(
  db: DatabaseSyncLike,
): Pick<HippoIndex, 'last_retrieval_ids' | 'last_trace_id'> {
  // Read both lockstep keys in ONE statement: two autocommit SELECTs could straddle a concurrent
  // saveIndex and return a mismatched pair.
  const lockstepRows = cachedStatement(
    db,
    `SELECT key, value FROM meta WHERE key IN ('last_retrieval_ids', 'last_trace_id')`,
  ).all() as Array<{ key: string; value: string }>;
  const lockstep = new Map(lockstepRows.map((r) => [r.key, r.value]));
  return {
    last_retrieval_ids: parseJsonArray(lockstep.get(META_KEY.lastRetrievalIds) ?? '[]', {
      table: 'meta',
      id: META_KEY.lastRetrievalIds,
      column: 'value',
    }),
    last_trace_id: parseLastTraceId(lockstep.get(META_KEY.lastTraceId) ?? ''),
  };
}

export function buildStatsFromDb(db: DatabaseSyncLike): LegacyStats {
  const runs = cachedStatement(
    db,
    `
    SELECT timestamp, decayed, merged, removed FROM (
      SELECT id, timestamp, decayed, merged, removed FROM consolidation_runs ORDER BY timestamp DESC, id DESC LIMIT ?
    ) ORDER BY timestamp ASC, id ASC
  `,
  ).all(CONSOLIDATION_RUNS_KEPT) as ConsolidationRunRow[];

  return {
    total_remembered: getMetaNumber(db, META_KEY.totalRemembered),
    total_recalled: getMetaNumber(db, META_KEY.totalRecalled),
    total_forgotten: getMetaNumber(db, META_KEY.totalForgotten),
    consolidation_runs: runs.map((run) => ({
      timestamp: run.timestamp,
      decayed: run.decayed,
      merged: run.merged,
      removed: run.removed,
    })),
  };
}

/** Write the `index.json` mirror file for an already-derived index. Exported for the longmemeval
 * benchmark. */
export function writeIndexMirror(hippoRoot: string, index: HippoIndex): void {
  mirrorBestEffort('index.json', () =>
    overwriteInPlace(path.join(hippoRoot, 'index.json'), JSON.stringify(index, null, 2)),
  );
}

function putStatsMirror(hippoRoot: string, stats: LegacyStats): void {
  // A root removed before its deferred write has nothing left to mirror.
  if (!fs.existsSync(hippoRoot)) return;
  overwriteInPlace(path.join(hippoRoot, 'stats.json'), JSON.stringify(stats, null, 2));
}

/** Mirror `stats` to stats.json at once, or, under a store runtime, hold it and write the latest
 * within a second of the last write; the database counters are always current. */
export function writeStatsMirror({ hippoRoot, runtime }: StoreAt, stats: LegacyStats): void {
  const write = (): void => putStatsMirror(hippoRoot, stats);
  if (runtime) runtime.held.writeOrHold(hippoRoot, 'stats.json', write);
  else mirrorBestEffort('stats.json', write);
}

/** Runs `write` once the current job is done, off the writer's path, as the root's next `what`
 * mirror write; a later call before it runs replaces it. With no store runtime it runs on the
 * next turn of the event loop. */
export function deferMirrorWrite(
  { hippoRoot, runtime }: StoreAt,
  what: string,
  write: () => void,
): void {
  if (runtime) runtime.held.hold(hippoRoot, what, write);
  else setImmediate(() => mirrorBestEffort(what, write));
}

// A truncate waits for the file's last write to reach the disk, so a file rewritten on every recall
// keeps its blocks.
function overwriteInPlace(file: string, text: string): void {
  const bytes = Buffer.from(text, 'utf8');
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT, 0o666);
  try {
    fs.writeSync(fd, bytes, 0, bytes.length, 0);
    fs.ftruncateSync(fd, bytes.length);
  } finally {
    fs.closeSync(fd);
  }
}

/** Mirrors are derived from SQLite and written after COMMIT, so a failed write warns instead of
 * failing a committed change. */
export function mirrorBestEffort(what: string, write: () => void): void {
  try {
    write();
  } catch (err) {
    log.warn(
      `${what} not refreshed (${errorMessage(err)}); the database write succeeded`,
      errorFields(err),
    );
  }
}

/** Pages through every row by rowid: each file is independent of the others, so row order does
 * not reach the output, and rowid keeps each page a seek (no index covers `created, id`). */
function* pagedMemoryRows(db: DatabaseSyncLike): Generator<MemoryEntry> {
  const page = cachedStatement(
    db,
    `SELECT rowid AS page_rowid, ${MEMORY_SELECT_COLUMNS} FROM memories WHERE rowid > ? ORDER BY rowid LIMIT ?`,
  );
  let after = 0;
  for (;;) {
    const rows = page.all(after, READ_PAGE_ROWS) as Array<MemoryRow & { page_rowid: number }>;
    if (rows.length === 0) return;
    after = rows[rows.length - 1]!.page_rowid;
    yield* rows.map(rowToEntry);
  }
}

export function syncMirrorFiles(at: StoreAt, db: DatabaseSyncLike): void {
  const { hippoRoot } = at;
  writeMarkdownMirrors(hippoRoot, pagedMemoryRows(db));
  const open = cachedStatement(
    db,
    `SELECT ${MEMORY_CONFLICT_COLUMNS} FROM memory_conflicts WHERE status = 'open' ORDER BY updated_at DESC, id DESC`,
  ).all() as ConflictWire[];
  mirrorBestEffort('conflict mirrors', () => writeAllConflictMirrors(hippoRoot, open));
  writeStatsMirror(at, buildStatsFromDb(db));
}

/** syncMirrorFiles for a pass that changed only `changed` and the conflicts it stamped
 * `conflictsAt`: every other mirror is already current. */
export function syncChangedMirrors(
  at: StoreAt,
  db: DatabaseSyncLike,
  changed: readonly MemoryEntry[],
  conflictsAt: string,
): void {
  const { hippoRoot } = at;
  writeMarkdownMirrors(hippoRoot, changed);
  const conflicts = cachedStatement(
    db,
    `SELECT ${MEMORY_CONFLICT_COLUMNS} FROM memory_conflicts WHERE updated_at = ?`,
  ).all(conflictsAt) as ConflictWire[];
  mirrorBestEffort('conflict mirrors', () => writeChangedConflictMirrors(hippoRoot, conflicts));
  writeStatsMirror(at, buildStatsFromDb(db));
}
