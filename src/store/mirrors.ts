import * as fs from 'fs';
import * as path from 'path';
import { Layer, type MemoryEntry } from '../memory.js';
import { dumpFrontmatter } from '../yaml.js';
import { openHippoDb, getMeta } from '../db.js';
import { log } from '../log.js';
import {
  type TaskSnapshot,
  type SessionEvent,
  type MemoryConflict,
  type HippoIndex,
  type IndexEntry,
  parseJsonArray,
  INDEX_VERSION,
  parseLastTraceId,
  type LegacyStats,
  type ConsolidationRunRow,
  MEMORY_SELECT_COLUMNS,
  type MemoryRow,
  rowToEntry,
  type MemoryConflictRow,
  rowToMemoryConflict,
} from './rows.js';
import { serializeEntry } from './markdown.js';

export function layerDir(root: string, layer: Layer): string {
  return path.join(root, layer);
}

export function ensureMirrorDirectories(hippoRoot: string): void {
  const dirs = [
    hippoRoot,
    path.join(hippoRoot, 'buffer'),
    path.join(hippoRoot, 'episodic'),
    path.join(hippoRoot, 'semantic'),
    path.join(hippoRoot, 'conflicts'),
  ];

  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

// Tenant-scoped mirror file paths. The single-tenant 'default' deployment
// keeps the original `active-task.md` / `recent-session.md` filenames for
// on-disk back-compat; multi-tenant deployments get a `.<tenantId>` suffix
// so tenant B saving cannot overwrite tenant A's mirror file.
function activeTaskMirrorPath(hippoRoot: string, tenantId: string): string {
  const file = tenantId === 'default' ? 'active-task.md' : `active-task.${tenantId}.md`;
  return path.join(hippoRoot, 'buffer', file);
}

function recentSessionMirrorPath(hippoRoot: string, tenantId: string): string {
  const file = tenantId === 'default' ? 'recent-session.md' : `recent-session.${tenantId}.md`;
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

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${fm}\n\n${body.join('\n')}`, 'utf8');
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

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${fm}\n\n${lines.join('\n')}`, 'utf8');
}

function writeConflictMirrors(hippoRoot: string, conflicts: MemoryConflict[]): void {
  const conflictDir = path.join(hippoRoot, 'conflicts');
  fs.mkdirSync(conflictDir, { recursive: true });

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
      `- Score: ${conflict.score.toFixed(3)}`,
      `- Status: ${conflict.status}`,
      '',
    ].join('\n');

    fs.writeFileSync(path.join(conflictDir, filename), `${fm}\n\n${body}`, 'utf8');
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
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${entry.id}.md`), serializeEntry(entry), 'utf8');
}

// AT1 P1 fix (codex): `writeMarkdownMirror` writes ANY layer's mirror,
// including `trace/<id>.md` for Layer.Trace rows (auto-promoted traces,
// consolidate.ts) — but this enumeration only walked
// Buffer/Episodic/Semantic. A rejected/forgotten trace row's markdown
// content survived on disk while the purge (and `hippo reject`/plain
// `forget`) reported success, and a stale trace mirror is exactly the
// resurrection channel bootstrapLegacyStore/rebuildIndex guard against.
// Fixes BOTH the AT1 reject-flow purge and the pre-existing plain-`forget`
// gap for trace rows (deleteEntry has always called this same function).
export function removeEntryMirrors(hippoRoot: string, id: string): void {
  for (const layer of [Layer.Buffer, Layer.Episodic, Layer.Semantic, Layer.Trace]) {
    const file = path.join(layerDir(hippoRoot, layer), `${id}.md`);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  }
}

/**
 * AT1 mirror-purge honesty fix (docs/plans/2026-08-15-at1-rejected-value-tombstone.md):
 * the candidate markdown mirror paths still on disk for `id`, computed the
 * same way `removeEntryMirrors` walks them (one per layer: buffer/episodic/
 * semantic), filtered to the ones that still `fs.existsSync`. Used to report
 * an EXPLICIT path when a best-effort purge fails and no reaper exists to
 * retry it — plain `removeEntryMirrors` returns void, giving no way to name
 * which file is stuck.
 */
export function getExistingEntryMirrorPaths(hippoRoot: string, id: string): string[] {
  // AT1 P1 fix (codex): same missing Layer.Trace as removeEntryMirrors above
  // — kept in lockstep with it since this function's whole purpose is
  // walking the mirror paths "the same way removeEntryMirrors walks them"
  // (see its own doc comment).
  return [Layer.Buffer, Layer.Episodic, Layer.Semantic, Layer.Trace]
    .map((layer) => path.join(layerDir(hippoRoot, layer), `${id}.md`))
    .filter((file) => fs.existsSync(file));
}

/**
 * AT1 fix: best-effort markdown-mirror purge shared by `reject-flow.ts`'s
 * `rejectValue` and `resolveConflict`'s post-commit purge. Both used to log
 * "will retry via reaper on next open" for EVERY failure, but the reaper
 * (`cleanupArchivedMirrors`, raw-archive-mirror-cleanup.ts) only scans
 * `raw_archive` — that message was false for a non-raw id, which has no
 * reaper at all.
 *
 * Retries the unlink once synchronously (the common real-world failure is a
 * transient lock/AV-scanner false positive, not a permanent one). On a
 * second failure: raw ids still get the honest reaper message (true); non-raw
 * ids get the EXPLICIT leftover file path(s) and a manual-delete instruction,
 * since nothing will ever retry them automatically.
 *
 * Returns true if the mirror ended up purged (first or second attempt).
 */
export function purgeMirrorBestEffort(
  hippoRoot: string,
  id: string,
  isRaw: boolean,
  logPrefix: string,
): boolean {
  try {
    removeEntryMirrors(hippoRoot, id);
    return true;
  } catch {
    try {
      removeEntryMirrors(hippoRoot, id);
      return true;
    } catch (secondErr) {
      const msg = secondErr instanceof Error ? secondErr.message : String(secondErr);
      if (isRaw) {
        log.error(
          `${logPrefix}: mirror cleanup failed for ${id} (will retry via reaper on next open): ${msg}`,
        );
      } else {
        const leftover = getExistingEntryMirrorPaths(hippoRoot, id);
        const pathsNote = leftover.length > 0 ? leftover.join(', ') : `${id}.md (path unresolved)`;
        log.error(
          `${logPrefix}: mirror cleanup failed for ${id} - no automatic retry exists for this file, ` +
          `delete it manually: ${pathsNote} (${msg})`,
        );
      }
      return false;
    }
  }
}

/** Derive the current `HippoIndex` from SQLite. Exported for `rebuildIndex`
 *  (the only index.json writer) and the longmemeval benchmark. */
export function buildIndexFromDb(db: ReturnType<typeof openHippoDb>): HippoIndex {
  // SAFETY: rows' shape matches the seven columns named in the SELECT below.
  const rows = db.prepare(`SELECT id, created, last_retrieved, strength, layer, tags_json, pinned FROM memories ORDER BY created ASC, id ASC`).all() as Array<{
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
    // SAFETY: layer is only ever written from the Layer enum by this
    // module's own INSERT/UPDATE paths.
    const layer = row.layer as Layer;
    entries[row.id] = {
      id: row.id,
      file: path.join(layer, `${row.id}.md`),
      layer,
      strength: Number(row.strength ?? 0),
      tags: parseJsonArray(row.tags_json),
      created: row.created,
      last_retrieved: row.last_retrieved,
      pinned: Boolean(row.pinned),
    };
  }

  // LC1 codex round-2 med: the two lockstep keys must be read in ONE
  // statement. Two autocommit SELECTs leave a window where a concurrent
  // saveIndex (which commits both keys in one transaction) lands between
  // them, handing the reader mismatched last_retrieval_ids / last_trace_id
  // and re-opening the mislinkage hole saveIndex's BEGIN/COMMIT closed on
  // the write side. One SELECT = one SQLite read snapshot.
  // SAFETY: lockstepRows' shape matches the key/value columns named above.
  const lockstepRows = db.prepare(
    `SELECT key, value FROM meta WHERE key IN ('last_retrieval_ids', 'last_trace_id')`,
  ).all() as Array<{ key: string; value: string }>;
  const lockstep = new Map(lockstepRows.map((r) => [r.key, r.value]));

  return {
    version: INDEX_VERSION,
    entries,
    last_retrieval_ids: parseJsonArray(lockstep.get('last_retrieval_ids') ?? '[]'),
    last_trace_id: parseLastTraceId(lockstep.get('last_trace_id') ?? ''),
  };
}

export function buildStatsFromDb(db: ReturnType<typeof openHippoDb>): LegacyStats {
  // SAFETY: runs' shape matches the four columns named in the SELECT above.
  const runs = db.prepare(`SELECT timestamp, decayed, merged, removed FROM consolidation_runs ORDER BY timestamp ASC, id ASC`).all() as ConsolidationRunRow[];

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

/** Write the `index.json` mirror file for an already-derived index. Exported for
 *  `rebuildIndex` (the only index.json writer) and the longmemeval benchmark. */
export function writeIndexMirror(hippoRoot: string, index: HippoIndex): void {
  mirrorBestEffort('index.json', () => fs.writeFileSync(path.join(hippoRoot, 'index.json'), JSON.stringify(index, null, 2), 'utf8'));
}

export function writeStatsMirror(hippoRoot: string, stats: LegacyStats): void {
  mirrorBestEffort('stats.json', () => fs.writeFileSync(path.join(hippoRoot, 'stats.json'), JSON.stringify(stats, null, 2), 'utf8'));
}

/** Mirrors are derived from SQLite and written after COMMIT, so a failed write warns instead of failing a committed change. */
export function mirrorBestEffort(what: string, write: () => void): void {
  try {
    write();
  } catch (err) {
    log.warn(`${what} not refreshed (${err instanceof Error ? err.message : String(err)}); the database write succeeded`);
  }
}

export function syncMirrorFiles(hippoRoot: string, db: ReturnType<typeof openHippoDb>): void {
  // SAFETY: this query selects exactly MEMORY_SELECT_COLUMNS, matching
  // MemoryRow's field set.
  const entries = db.prepare(`SELECT ${MEMORY_SELECT_COLUMNS} FROM memories ORDER BY created ASC, id ASC`).all() as MemoryRow[];

  mirrorBestEffort('markdown mirrors', () => {
    for (const entry of entries.map(rowToEntry)) writeMarkdownMirror(hippoRoot, entry);
  });

  // SAFETY: conflicts' shape matches the eight columns named in the SELECT
  // above.
  const conflicts = db.prepare(`
    SELECT id, memory_a_id, memory_b_id, reason, score, status, detected_at, updated_at
    FROM memory_conflicts
    WHERE status = 'open'
    ORDER BY updated_at DESC, id DESC
  `).all() as MemoryConflictRow[];
  mirrorBestEffort('conflict mirrors', () => writeConflictMirrors(hippoRoot, conflicts.map(rowToMemoryConflict)));

  writeStatsMirror(hippoRoot, buildStatsFromDb(db));
}
