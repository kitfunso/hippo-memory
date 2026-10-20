import { DEFAULT_TENANT_ID } from '../../base/util/tenant.js';
import * as fs from 'fs';
import * as path from 'path';
import { Layer, type MemoryEntry } from '../../base/memory/memory.js';
import { dumpFrontmatter } from '../../base/util/yaml.js';
import { type DatabaseSyncLike, getMeta, CONSOLIDATION_RUNS_KEPT } from '../../db/index.js';
import { oncePerStore } from '../../db/connect.js';
import { errorFields, errorMessage, log } from '../../base/util/log.js';
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
  type MemoryConflictRow,
  rowToMemoryConflict,
} from './rows.js';
import type { LegacyStats } from '../port/reports.js';
import type { MemoryConflict } from '../port/conflicts.js';
import type { TaskSnapshot, SessionEvent } from '../port/sessions.js';
import { serializeEntry } from '../../base/memory/markdown.js';
import { writeFileAtomic } from '../../base/util/atomic-write.js';
import type { StoreFiles } from './open.js';

const SCORE_DECIMALS = 3;

// Mirrors are derived and rebuildable from the store, so they skip the fsyncs (the cost on Windows) and keep the
// temp-and-rename atomicity.
function writeMirror(file: string, text: string): void {
  writeFileAtomic(file, text, { durable: false });
}

export function layerDir(root: string, layer: Layer): string {
  return path.join(root, layer);
}

// Owner-only wherever a mirror folder is made, at open or by a writer that finds it gone.
const MIRROR_FOLDER = { recursive: true, mode: 0o700 } as const;

/** Makes the mirror folders on a store's first open in this process; a writer makes its own folder if one goes missing
 * later. */
export function ensureMirrorDirectories(hippoRoot: string): void {
  oncePerStore(hippoRoot, 'mirror-folders', () => {
    for (const sub of ['buffer', 'episodic', 'semantic', 'conflicts']) {
      fs.mkdirSync(path.join(hippoRoot, sub), MIRROR_FOLDER);
    }
  });
}

// Tenant-scoped mirror paths: the 'default' tenant keeps the original `active-task.md` / `recent-session.md` names;
// other tenants get a `.<tenantId>` suffix so one cannot overwrite another's mirror.
function activeTaskMirrorPath(hippoRoot: string, tenantId: string): string {
  const file = tenantId === DEFAULT_TENANT_ID ? 'active-task.md' : `active-task.${tenantId}.md`;
  return path.join(hippoRoot, 'buffer', file);
}

function recentSessionMirrorPath(hippoRoot: string, tenantId: string): string {
  const file = tenantId === DEFAULT_TENANT_ID ? 'recent-session.md' : `recent-session.${tenantId}.md`;
  return path.join(hippoRoot, 'buffer', file);
}

export function writeActiveTaskMirror(hippoRoot: string, tenantId: string, snapshot: TaskSnapshot): void {
  const filePath = activeTaskMirrorPath(hippoRoot, tenantId);
  const fm = dumpFrontmatter({
    id: snapshot.id,
    task: snapshot.task,
    status: snapshot.status,
    source: snapshot.source,
    session_id: snapshot.session_id,
    created_at: snapshot.created_at,
    updated_at: snapshot.updated_at,
    next_step: snapshot.next_step,
  });

  const body = [
    `# Active Task Snapshot`,
    '',
    `## Summary`,
    snapshot.summary,
    '',
    `## Next step`,
    snapshot.next_step,
    '',
    `## Task`,
    snapshot.task,
    '',
  ];

  if (snapshot.session_id) {
    body.push(`## Session`, snapshot.session_id, '');
  }

  fs.mkdirSync(path.dirname(filePath), MIRROR_FOLDER);
  writeMirror(filePath, `${fm}\n\n${body.join('\n')}`);
}

export function removeActiveTaskMirror(hippoRoot: string, tenantId: string): void {
  const filePath = activeTaskMirrorPath(hippoRoot, tenantId);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

export function writeRecentSessionMirror(hippoRoot: string, tenantId: string, events: SessionEvent[]): void {
  const filePath = recentSessionMirrorPath(hippoRoot, tenantId);
  if (events.length === 0) {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    return;
  }

  const latest = events[events.length - 1]!;
  const fm = dumpFrontmatter({
    session_id: latest.session_id,
    task: latest.task,
    event_count: events.length,
    updated_at: latest.created_at,
  });

  const lines = [
    '# Recent Session Trail',
    '',
    `- Session: ${latest.session_id}`,
    `- Task: ${latest.task ?? 'n/a'}`,
    `- Updated: ${latest.created_at}`,
    '',
    '## Events',
    '',
  ];

  for (const event of events) {
    lines.push(`- [${event.created_at}] (${event.event_type}) ${event.content}`);
  }

  lines.push('');

  fs.mkdirSync(path.dirname(filePath), MIRROR_FOLDER);
  writeMirror(filePath, `${fm}\n\n${lines.join('\n')}`);
}

function writeConflictMirrors(hippoRoot: string, conflicts: MemoryConflict[]): void {
  const conflictDir = path.join(hippoRoot, 'conflicts');
  fs.mkdirSync(conflictDir, MIRROR_FOLDER);

  const keep = new Set<string>();
  for (const conflict of conflicts) {
    const filename = `conflict_${conflict.id}.md`;
    keep.add(filename);

    const fm = dumpFrontmatter({
      id: conflict.id,
      memory_a_id: conflict.memory_a_id,
      memory_b_id: conflict.memory_b_id,
      reason: conflict.reason,
      score: Math.round(conflict.score * 10000) / 10000,
      status: conflict.status,
      detected_at: conflict.detected_at,
      updated_at: conflict.updated_at,
    });

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

    writeMirror(path.join(conflictDir, filename), `${fm}\n\n${body}`);
  }

  for (const existing of fs.readdirSync(conflictDir)) {
    if (existing === '.gitkeep') continue;
    if (!keep.has(existing)) {
      fs.unlinkSync(path.join(conflictDir, existing));
    }
  }
}

export function writeMarkdownMirror(hippoRoot: string, entry: MemoryEntry): void {
  removeEntryMirrors(hippoRoot, entry.id);
  const dir = layerDir(hippoRoot, entry.layer);
  fs.mkdirSync(dir, MIRROR_FOLDER);
  writeMirror(path.join(dir, `${entry.id}.md`), serializeEntry(entry));
}

// Every layer, Trace included: `writeMarkdownMirror` writes any layer, and a stale trace mirror is the resurrection
// channel bootstrapLegacyStore guards against.
const MIRROR_LAYERS = [Layer.Buffer, Layer.Episodic, Layer.Semantic, Layer.Trace] as const;

export function removeEntryMirrors(hippoRoot: string, id: string): void {
  for (const layer of MIRROR_LAYERS) {
    const file = path.join(layerDir(hippoRoot, layer), `${id}.md`);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  }
}

/** A folder the batch writes into is listed once when this many of its entries sit in other layers and would each probe
 * it: a layer folder can hold every mirror in the store. */
const LISTING_MIN_BATCH = 64;

/** The names in each listed layer folder; a layer with no listing is probed file by file. */
type LayerListing = ReadonlyMap<Layer, ReadonlySet<string>>;

/** writeMarkdownMirror for many entries; returns the ids whose file it wrote. A file that fails is warned about and the
 * rest still land. */
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
          `${entry.id}.md not refreshed (${errorMessage(err)}); the database ` + `write succeeded`,
          errorFields(err),
        );
      }
    }
  });
  return written;
}

/** A stream of every row lists all four folders; a batch lists only folders it writes into that enough of its entries
 * would probe for a copy left in another layer. */
function listedLayers(hippoRoot: string, entries: Iterable<MemoryEntry>): LayerListing {
  let layers: readonly Layer[] = MIRROR_LAYERS;
  if (Array.isArray(entries)) {
    const inLayer = new Map<Layer, number>();
    for (const entry of entries) inLayer.set(entry.layer, (inLayer.get(entry.layer) ?? 0) + 1);
    layers = [...inLayer].filter(([, n]) => entries.length - n >= LISTING_MIN_BATCH).map(([layer]) => layer);
  }
  return new Map(
    layers.map((layer) => {
      const dir = layerDir(hippoRoot, layer);
      return [layer, new Set(fs.existsSync(dir) ? fs.readdirSync(dir) : [])];
    }),
  );
}

/** writeMarkdownMirror against `listed`: a copy in another layer's folder goes, found in its listing or by a probe, and
 * the entry's own file is replaced in place, so no crash leaves it missing; `made` holds the folders already made. */
function writeListedMirror(hippoRoot: string, entry: MemoryEntry, listed: LayerListing, made: Set<string>): void {
  const name = `${entry.id}.md`;
  for (const layer of MIRROR_LAYERS) {
    if (layer === entry.layer) continue;
    const file = path.join(layerDir(hippoRoot, layer), name);
    if (listed.get(layer)?.has(name) ?? fs.existsSync(file)) fs.rmSync(file, { force: true });
  }
  const dir = layerDir(hippoRoot, entry.layer);
  if (!made.has(dir)) fs.mkdirSync(dir, MIRROR_FOLDER);
  made.add(dir);
  writeMirror(path.join(dir, name), serializeEntry(entry));
}

export function removeEntryMirrorsIn(files: StoreFiles, id: string): void {
  removeEntryMirrors(files.hippoRoot, id);
}

/** Mirror paths for `id` still on disk, walked like `removeEntryMirrors`, so a failed purge with no reaper to retry it
 * can name the stuck file. */
function getExistingEntryMirrorPaths(hippoRoot: string, id: string): string[] {
  return MIRROR_LAYERS.map((layer) => path.join(layerDir(hippoRoot, layer), `${id}.md`)).filter((file) =>
    fs.existsSync(file),
  );
}

/** Best-effort mirror purge: retries the unlink once (most failures are transient locks); the reaper only scans
 * `raw_archive`, so a non-raw id's second failure logs the leftover path(s) to delete by hand. Returns true if the
 * mirror ended up purged. */
export function purgeMirrorBestEffort(hippoRoot: string, id: string, isRaw: boolean, logPrefix: string): boolean {
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
        const leftover = getExistingEntryMirrorPaths(hippoRoot, id);
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

export function purgeMirrorBestEffortIn(files: StoreFiles, id: string, isRaw: boolean, logPrefix: string): boolean {
  return purgeMirrorBestEffort(files.hippoRoot, id, isRaw, logPrefix);
}

/** Derive the current `HippoIndex` from SQLite. Exported for the longmemeval benchmark. */
export function buildIndexFromDb(db: DatabaseSyncLike): HippoIndex {
  const rows = db
    .prepare(
      `SELECT id, created, last_retrieved, strength, layer, tags_json, pinned FROM memories ORDER BY created ASC, id ` +
        `ASC`,
    )
    .all() as Array<{
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
    // SAFETY: layer is only ever written from the Layer enum by this module's own INSERT/UPDATE paths.
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
export function readLastRecall(db: DatabaseSyncLike): Pick<HippoIndex, 'last_retrieval_ids' | 'last_trace_id'> {
  // Read both lockstep keys in ONE statement: two autocommit SELECTs could straddle a concurrent saveIndex and return a
  // mismatched pair.
  const lockstepRows = db
    .prepare(`SELECT key, value FROM meta WHERE key IN ('last_retrieval_ids', 'last_trace_id')`)
    .all() as Array<{ key: string; value: string }>;
  const lockstep = new Map(lockstepRows.map((r) => [r.key, r.value]));
  return {
    last_retrieval_ids: parseJsonArray(lockstep.get('last_retrieval_ids') ?? '[]', {
      table: 'meta',
      id: 'last_retrieval_ids',
      column: 'value',
    }),
    last_trace_id: parseLastTraceId(lockstep.get('last_trace_id') ?? ''),
  };
}

export function buildStatsFromDb(db: DatabaseSyncLike): LegacyStats {
  const runs = db
    .prepare(`
    SELECT timestamp, decayed, merged, removed FROM (
      SELECT id, timestamp, decayed, merged, removed FROM consolidation_runs ORDER BY timestamp DESC, id DESC LIMIT ?
    ) ORDER BY timestamp ASC, id ASC
  `)
    .all(CONSOLIDATION_RUNS_KEPT) as ConsolidationRunRow[];

  return {
    total_remembered: Number(getMeta(db, 'total_remembered', '0')),
    total_recalled: Number(getMeta(db, 'total_recalled', '0')),
    total_forgotten: Number(getMeta(db, 'total_forgotten', '0')),
    consolidation_runs: runs.map((run) => ({
      timestamp: run.timestamp,
      decayed: run.decayed,
      merged: run.merged,
      removed: run.removed,
    })),
  };
}

/** Write the `index.json` mirror file for an already-derived index. Exported for the longmemeval benchmark. */
export function writeIndexMirror(hippoRoot: string, index: HippoIndex): void {
  mirrorBestEffort('index.json', () =>
    overwriteInPlace(path.join(hippoRoot, 'index.json'), JSON.stringify(index, null, 2)),
  );
}

const HELD_MIRROR_INTERVAL_MS = 1000;

/** One root's held mirror writes, the latest of each kind, run together when its timer fires. */
interface HeldMirrors {
  lastWrite: number;
  readonly writes: Map<string, () => void>;
  timer?: NodeJS.Timeout;
}

const heldMirrors = new Map<string, HeldMirrors>();
let exitHookInstalled = false;

function putStatsMirror(hippoRoot: string, stats: LegacyStats): void {
  // A root removed before its deferred write has nothing left to mirror.
  if (!fs.existsSync(hippoRoot)) return;
  mirrorBestEffort('stats.json', () =>
    overwriteInPlace(path.join(hippoRoot, 'stats.json'), JSON.stringify(stats, null, 2)),
  );
}

function heldFor(hippoRoot: string): HeldMirrors {
  const key = path.resolve(hippoRoot);
  dropIdleMirrors();
  const state = heldMirrors.get(key) ?? { lastWrite: 0, writes: new Map() };
  heldMirrors.set(key, state);
  return state;
}

/** Makes `write` the next `what` write of the root, run within an interval of the root's last mirror write. */
function hold(hippoRoot: string, state: HeldMirrors, what: string, write: () => void): void {
  state.writes.set(what, write);
  if (state.timer !== undefined) return;
  if (!exitHookInstalled) {
    process.on('exit', () => flushHeldMirrors());
    exitHookInstalled = true;
  }
  const wait = Math.max(0, state.lastWrite + HELD_MIRROR_INTERVAL_MS - Date.now());
  state.timer = setTimeout(() => flushHeldMirrors(hippoRoot), wait);
  state.timer.unref();
}

/** Mirror `stats` to stats.json at once, or hold it and write the latest within a second of the last write; the
 * database counters are always current. */
export function writeStatsMirror(hippoRoot: string, stats: LegacyStats): void {
  const state = heldFor(hippoRoot);
  // Behind a pending timer it waits its turn, so an older held copy never lands after it.
  if (state.timer === undefined && state.lastWrite + HELD_MIRROR_INTERVAL_MS <= Date.now()) {
    state.lastWrite = Date.now();
    putStatsMirror(hippoRoot, stats);
    return;
  }
  hold(hippoRoot, state, 'stats.json', () => putStatsMirror(hippoRoot, stats));
}

/** Runs `write` once the current job is done, off the writer's path, as the root's next `what` mirror write; a later
 * call before it runs replaces it. */
export function deferMirrorWrite(hippoRoot: string, what: string, write: () => void): void {
  hold(hippoRoot, heldFor(hippoRoot), what, write);
}

// A root idle for a full interval needs no throttle state, so the map holds only recently written roots.
function dropIdleMirrors(): void {
  const now = Date.now();
  for (const [root, state] of heldMirrors) {
    if (state.timer === undefined && state.writes.size === 0 && now - state.lastWrite >= HELD_MIRROR_INTERVAL_MS) {
      heldMirrors.delete(root);
    }
  }
}

/** Runs any held mirror write now, for one root or all; store close, worker stop and process exit call it. */
export function flushHeldMirrors(hippoRoot?: string): void {
  const key = hippoRoot === undefined ? undefined : path.resolve(hippoRoot);
  for (const [root, state] of heldMirrors) {
    if (key !== undefined && root !== key) continue;
    if (state.timer !== undefined) clearTimeout(state.timer);
    heldMirrors.delete(root);
    for (const [what, write] of state.writes) mirrorBestEffort(what, write);
  }
}

// A truncate waits for the file's last write to reach the disk, so a file rewritten on every recall keeps its blocks.
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

/** Mirrors are derived from SQLite and written after COMMIT, so a failed write warns instead of failing a committed
 * change. */
export function mirrorBestEffort(what: string, write: () => void): void {
  try {
    write();
  } catch (err) {
    log.warn(`${what} not refreshed (${errorMessage(err)}); the database write succeeded`, errorFields(err));
  }
}

/** Rows per page when every memory is walked, so a large store never sits in memory whole. */
const MIRROR_PAGE_ROWS = 500;

/** Pages through every row by rowid: each file is independent of the others, so row order does not reach the output,
 * and rowid keeps each page a seek (no index covers `created, id`). */
function* pagedMemoryRows(db: DatabaseSyncLike): Generator<MemoryEntry> {
  const page = db.prepare(
    `SELECT rowid AS page_rowid, ${MEMORY_SELECT_COLUMNS} FROM memories WHERE rowid > ? ORDER BY rowid LIMIT ?`,
  );
  let after = 0;
  for (;;) {
    const rows = page.all(after, MIRROR_PAGE_ROWS) as Array<MemoryRow & { page_rowid: number }>;
    if (rows.length === 0) return;
    after = rows[rows.length - 1]!.page_rowid;
    yield* rows.map(rowToEntry);
  }
}

export function syncMirrorFiles(hippoRoot: string, db: DatabaseSyncLike): void {
  writeMarkdownMirrors(hippoRoot, pagedMemoryRows(db));
  syncSideMirrors(hippoRoot, db);
}

/** syncMirrorFiles for a pass that changed only `changed`: the other rows' markdown is already current. */
export function syncChangedMirrors(hippoRoot: string, db: DatabaseSyncLike, changed: readonly MemoryEntry[]): void {
  writeMarkdownMirrors(hippoRoot, changed);
  syncSideMirrors(hippoRoot, db);
}

/** The conflict and stats mirrors, which a full sync and a partial one refresh alike. */
function syncSideMirrors(hippoRoot: string, db: DatabaseSyncLike): void {
  const conflicts = db
    .prepare(
      `
    SELECT ${MEMORY_CONFLICT_COLUMNS}
    FROM memory_conflicts
    WHERE status = 'open'
    ORDER BY updated_at DESC, id DESC
  `,
    )
    .all() as MemoryConflictRow[];
  mirrorBestEffort('conflict mirrors', () => writeConflictMirrors(hippoRoot, conflicts.map(rowToMemoryConflict)));

  writeStatsMirror(hippoRoot, buildStatsFromDb(db));
}
