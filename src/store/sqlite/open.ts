// The store's handle types and the legacy setup a first open runs; src/store/sqlite/handles.ts opens hippo.db, the
// source of truth, and Markdown and JSON files are human-readable mirrors of it.

import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_HALF_LIFE_DAYS, type LossAversion, type MemoryEntry, Layer } from '../../base/memory/memory.js';
import {
  type DatabaseSyncLike,
  openHippoDb,
  getMeta,
  setMeta,
  withWriteScope,
  pruneConsolidationRuns,
} from '../../db/index.js';
import { RejectedValueError } from '../../base/errors/api-errors.js';
import { errorFields, errorMessage, log } from '../../base/util/log.js';
import { type HippoIndex } from './rows.js';
import type { LegacyStats } from '../port/reports.js';
import { audit } from './audit-event.js';
import { deserializeEntry } from '../../base/memory/markdown.js';
import { stampOriginProjectForImport, upsertEntryRow } from './entry-row.js';
import { layerDir } from './mirrors.js';
import { isJsonObject, type JsonValue } from '../../base/util/json.js';
import { CLI_ACTOR } from '../../base/scope/actor.js';

/** The folder a store keeps its mirror files in, beside hippo.db, with the ratio its root built it with; an adapter
 * hands it on and never reads it. */
export interface StoreFiles extends LossAversion {
  readonly hippoRoot: string;
}

export type HandleOpener = (hippoRoot: string) => DatabaseSyncLike;

/** One call on a handle of the store's own, closed after; `open` defaults to a bare handle, `openStore` also sets up
 * the mirror folders. */
export type OnHandle = <T>(fn: (db: DatabaseSyncLike, files: StoreFiles) => T, open?: HandleOpener) => T;

export type OnHandleAsync = <T>(
  fn: (db: DatabaseSyncLike, files: StoreFiles) => Promise<T>,
  open?: HandleOpener,
) => Promise<T>;

/** An opener that waits on a locked store for `busyWaitMs` in place of the default wait. */
export function waitingOpener(
  busyWaitMs: number | undefined,
  open: (hippoRoot: string, opts?: { busyWaitMs?: number }) => DatabaseSyncLike = openHippoDb,
): HandleOpener {
  return (hippoRoot) => open(hippoRoot, { busyWaitMs });
}

/** What an adapter gets of the store it serves: the openers and the files beside hippo.db, never the folder itself. */
export interface Handles {
  readonly on: OnHandle;
  readonly onAsync: OnHandleAsync;
  /** A bare handle the caller closes, for work that keeps one across several calls. */
  readonly open: () => DatabaseSyncLike;
  readonly files: StoreFiles;
}

/** `meta` key holding the default half-life base a store's memories are on; see
 * src/domain/consolidate/half-life-migration.ts. */
export const HALF_LIFE_BASE_META_KEY = 'default_half_life_base';
/** `meta` key set once no memory of a decision, incident or other object sits on the old flat 90 days. */
export const TYPED_HALF_LIFE_META_KEY = 'typed_half_life_on_default';

/** A store with no memories starts on the current default half-life base so `hippo sleep` never migrates it; one that
 * holds memories but no recorded base predates the record and keeps the legacy 7-day base until sleep migrates it. */
export function recordHalfLifeBaseForNewStore(db: DatabaseSyncLike): void {
  if (getMeta(db, HALF_LIFE_BASE_META_KEY, '') !== '') return;
  if (db.prepare(`SELECT 1 AS x FROM memories LIMIT 1`).get() !== undefined) return;
  setMeta(db, HALF_LIFE_BASE_META_KEY, String(DEFAULT_HALF_LIFE_DAYS));
  setMeta(db, TYPED_HALF_LIFE_META_KEY, '1');
}

/** Imports a markdown-era store's mirrors into an empty hippo.db once; true when it imported any row. */
export function bootstrapLegacyStore(db: ReturnType<typeof openHippoDb>, hippoRoot: string): boolean {
  // Existence, not COUNT(*): a count walks every row on each write's open.
  if (db.prepare(`SELECT 1 AS x FROM memories LIMIT 1`).get() !== undefined) return false;
  // The row check misses an all-rejected bootstrap (memories stays empty), which would re-run the import on every open
  // and duplicate consolidation_runs; this meta flag settles it.
  if (getMeta(db, 'legacy_bootstrap_completed', '0') === '1') return false;

  const legacyEntries = loadLegacyEntriesFromMarkdown(hippoRoot);
  if (legacyEntries.length === 0) return false;

  withWriteScope(db, 'bootstrap_legacy_store', () => {
    importLegacyEntries(db, hippoRoot, legacyEntries, 'bootstrapLegacyStore');
    importLegacyIndexAndStats(db, hippoRoot);

    // Stamp completion even when every row was rejected; see the gate above.
    setMeta(db, 'legacy_bootstrap_completed', '1');
  });
  return true;
}

function importLegacyEntries(
  db: DatabaseSyncLike,
  hippoRoot: string,
  legacyEntries: MemoryEntry[],
  caller: string,
): void {
  // Guard live per row: a stale markdown mirror could resurrect a rejected value. Plain audit() inline, because nothing
  // rolls back on a per-row skip.
  let rejectedCount = 0;
  for (const entry of legacyEntries) {
    // v39: legacy markdown carries no origin_project; stamp from the store location so bootstrapped rows stay visible
    // to ambient context.
    const stamped = stampOriginProjectForImport(hippoRoot, entry);
    try {
      upsertEntryRow(db, stamped);
    } catch (err) {
      if (err instanceof RejectedValueError) {
        rejectedCount++;
        audit(db, 'reject_refusal', {
          targetId: err.entryId,
          metadata: { digest: err.digest, reason: err.reason },
          actor: CLI_ACTOR,
          tenantId: err.tenantId,
        });
        continue;
      }
      throw err;
    }
  }
  if (rejectedCount > 0) {
    log.warn(`${caller}: skipped ${rejectedCount} rejected value(s) found in legacy mirrors`);
  }
}

function importLegacyIndexAndStats(db: DatabaseSyncLike, hippoRoot: string): void {
  const legacyIndex = loadLegacyIndexFile(hippoRoot);
  setMeta(db, 'last_retrieval_ids', JSON.stringify(legacyIndex.last_retrieval_ids ?? []));
  // Legacy index.json predates last_trace_id, so '' is normal; accept only a clean digit string rather than trusting a
  // hand-edited or corrupt index.json.
  const legacyTraceId = String(legacyIndex.last_trace_id ?? '');
  setMeta(db, 'last_trace_id', /^\d+$/.test(legacyTraceId) ? legacyTraceId : '');

  const legacyStats = loadLegacyStatsFile(hippoRoot);
  setMeta(db, 'total_remembered', String(Number(legacyStats.total_remembered ?? 0)));
  setMeta(db, 'total_recalled', String(Number(legacyStats.total_recalled ?? 0)));
  setMeta(db, 'total_forgotten', String(Number(legacyStats.total_forgotten ?? 0)));

  const runs = Array.isArray(legacyStats.consolidation_runs) ? legacyStats.consolidation_runs : [];
  const insertRun = db.prepare(
    `INSERT INTO consolidation_runs(timestamp, decayed, merged, removed) VALUES (?, ?, ?, ?)`,
  );
  for (const run of runs) {
    if (!isJsonObject(run)) continue;
    const row = run;
    insertRun.run(
      String(row.timestamp ?? new Date().toISOString()),
      Number(row.decayed ?? 0),
      Number(row.merged ?? 0),
      Number(row.removed ?? 0),
    );
  }
  // Same cap as every later sleep, so stats.json and the table agree from the first open.
  pruneConsolidationRuns(db);
}

function loadLegacyEntriesFromMarkdown(hippoRoot: string): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  for (const layer of [Layer.Buffer, Layer.Episodic, Layer.Semantic]) {
    const dir = layerDir(hippoRoot, layer);
    if (!fs.existsSync(dir)) continue;

    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.md')) continue;
      try {
        const entry = deserializeEntry(fs.readFileSync(path.join(dir, file), 'utf8'));
        if (entry) entries.push(entry);
      } catch (err) {
        log.warn(`store: skipped unreadable legacy file ${file}: ${errorMessage(err)}`, errorFields(err));
      }
    }
  }
  return entries;
}

function readLegacyJsonObject(file: string): { [key: string]: JsonValue } | null {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    log.warn(`store: unreadable ${path.basename(file)} read as empty: ${errorMessage(err)}`, errorFields(err));
    return null;
  }
  if (!isJsonObject(parsed)) {
    log.warn(`store: ${path.basename(file)} is not a JSON object, read as empty`);
    return null;
  }
  return parsed;
}

function loadLegacyIndexFile(hippoRoot: string): HippoIndex {
  const indexPath = path.join(hippoRoot, 'index.json');
  const empty: HippoIndex = { version: 1, entries: {}, last_retrieval_ids: [], last_trace_id: null };
  if (!fs.existsSync(indexPath)) return empty;
  // SAFETY: index.json is written by writeIndexMirror as a HippoIndex; readers default every field, so only the object
  // shape is checked.
  return (readLegacyJsonObject(indexPath) as HippoIndex | null) ?? empty;
}

function loadLegacyStatsFile(hippoRoot: string): LegacyStats {
  const statsPath = path.join(hippoRoot, 'stats.json');
  const empty: LegacyStats = { total_remembered: 0, total_recalled: 0, total_forgotten: 0, consolidation_runs: [] };
  if (!fs.existsSync(statsPath)) return empty;
  // SAFETY: callers guard every field read with `?? 0` / `Array.isArray`, so only the object shape is checked.
  return (readLegacyJsonObject(statsPath) as LegacyStats | null) ?? empty;
}
