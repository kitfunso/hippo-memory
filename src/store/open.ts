// Opens the SQLite store, the source of truth; Markdown and JSON files are human-readable mirrors of it.

import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_HALF_LIFE_DAYS, type MemoryEntry, Layer } from '../memory.js';
import { closeHippoDb, currentRequestStores, type DatabaseSyncLike, openHippoDb, getMeta, setMeta, withWriteScope } from '../db.js';
import { openHippoDbWithFacts } from '../db/open.js';
import { type ResolveProjectIdentityOpts, findHippoStoreDir } from '../project-identity.js';
import { realpathOrResolve } from '../util/real-path.js';
import { RejectedValueError } from './rejection.js';
import { errorMessage, log } from '../log.js';
import { type HippoIndex, type LegacyStats } from './rows.js';
import { audit } from './audit-event.js';
import { deserializeEntry } from './markdown.js';
import { stampOriginProjectForImport, upsertEntryRow } from './entry-row.js';
import { ensureMirrorDirectories, syncMirrorFiles, layerDir } from './mirrors.js';
import { isJsonObject } from '../json.js';

/** Nearest ancestor store like git; the strict join is the fallback so `hippo init` still creates `<cwd>/.hippo`. */
export function getHippoRoot(cwd: string = process.cwd(), opts?: ResolveProjectIdentityOpts): string {
  return findHippoStoreDir(cwd, opts) ?? path.join(realpathOrResolve(cwd), '.hippo');
}

export function isInitialized(hippoRoot: string): boolean {
  // autoInstallHooks / setupDailySchedule can create a bare .hippo with no hippo.db; counting
  // that as initialized makes `hippo init` skip initStore, so only hippo.db counts.
  return fs.existsSync(path.join(hippoRoot, 'hippo.db'));
}

export function initStore(hippoRoot: string): void {
  closeHippoDb(openStore(hippoRoot));
}

/** One open connection with init done on it, for callers who used to pay for `initStore` + a second `openHippoDb`. */
export function openStore(hippoRoot: string, opts?: { busyWaitMs?: number }): DatabaseSyncLike {
  // Open first: a folder marked for another store must refuse before any mirror folder appears.
  const { db, facts } = openHippoDbWithFacts(hippoRoot, opts);
  // A store worker's reader: its writer ran the steps below before this thread was sent a job, and this connection cannot write them.
  if (currentRequestStores()?.setupDoneFor === hippoRoot) return db;
  try {
    ensureMirrorDirectories(hippoRoot);
    // Both steps act only on a store with no memory row, which the open's own probe has just ruled out.
    if (facts?.hasMemories) return db;
    const bootstrapped = bootstrapLegacyStore(db, hippoRoot);
    if (bootstrapped) {
      syncMirrorFiles(hippoRoot, db);
    }
    recordHalfLifeBaseForNewStore(db);
    return db;
  } catch (error) {
    try {
      closeHippoDb(db);
    } catch {
      // Best effort only; surface the original init error.
    }
    throw error;
  }
}

/** One call on a handle of its own, closed after; pass openStore where the call also sets up mirror folders and legacy rows. */
export function onHandle<T>(hippoRoot: string, fn: (db: DatabaseSyncLike) => T, open: (hippoRoot: string) => DatabaseSyncLike = openHippoDb): T {
  const db = open(hippoRoot);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

/** `meta` key holding the default half-life base a store's memories are on (src/half-life-migration.ts). */
export const HALF_LIFE_BASE_META_KEY = 'default_half_life_base';
/** `meta` key set once no memory of a decision, incident or other object sits on the old flat 90 days. */
export const TYPED_HALF_LIFE_META_KEY = 'typed_half_life_on_default';
/** The flat half-life the decision, incident and other object writers gave their memories before they took the default. */
export const LEGACY_TYPED_HALF_LIFE = 90;

/**
 * A store with no memories starts on the current default half-life base, so
 * `hippo sleep` never migrates it. A store that already holds memories and
 * no recorded base predates the record, and keeps reading as the legacy
 * 7-day base until sleep migrates it.
 */
function recordHalfLifeBaseForNewStore(db: DatabaseSyncLike): void {
  if (getMeta(db, HALF_LIFE_BASE_META_KEY, '') !== '') return;
  if (db.prepare(`SELECT 1 AS x FROM memories LIMIT 1`).get() !== undefined) return;
  setMeta(db, HALF_LIFE_BASE_META_KEY, String(DEFAULT_HALF_LIFE_DAYS));
  setMeta(db, TYPED_HALF_LIFE_META_KEY, '1');
}

function bootstrapLegacyStore(db: ReturnType<typeof openHippoDb>, hippoRoot: string): boolean {
  // Existence, not COUNT(*): a count walks every row on each write's open.
  if (db.prepare(`SELECT 1 AS x FROM memories LIMIT 1`).get() !== undefined) return false;
  // The row check misses an all-rejected bootstrap (memories stays empty), which would re-run the
  // import on every open and duplicate consolidation_runs; this meta flag settles it.
  if (getMeta(db, 'legacy_bootstrap_completed', '0') === '1') return false;

  const legacyEntries = loadLegacyEntriesFromMarkdown(hippoRoot);
  if (legacyEntries.length === 0) return false;

  withWriteScope(db, 'bootstrap_legacy_store', () => {
    importLegacyEntries(db, hippoRoot, legacyEntries);
    importLegacyIndexAndStats(db, hippoRoot);

    // Stamp completion even when every row was rejected; see the gate above.
    setMeta(db, 'legacy_bootstrap_completed', '1');
  });
  return true;
}

function importLegacyEntries(db: DatabaseSyncLike, hippoRoot: string, legacyEntries: MemoryEntry[]): void {
  // Guard live per row: a stale markdown mirror could resurrect a rejected value. Plain audit()
  // inline, because nothing rolls back on a per-row skip.
  let rejectedCount = 0;
  for (const entry of legacyEntries) {
    // v39: legacy markdown carries no origin_project; stamp from the store
    // location so bootstrapped rows stay visible to ambient context.
    const stamped = stampOriginProjectForImport(hippoRoot, entry);
    try {
      upsertEntryRow(db, stamped);
    } catch (err) {
      if (err instanceof RejectedValueError) {
        rejectedCount++;
        audit(db, 'reject_refusal', { targetId: err.entryId, metadata: { digest: err.digest, reason: err.reason }, actor: 'cli', tenantId: err.tenantId });
        continue;
      }
      throw err;
    }
  }
  if (rejectedCount > 0) {
    log.warn(`bootstrapLegacyStore: skipped ${rejectedCount} rejected value(s) found in legacy mirrors`);
  }
}

function importLegacyIndexAndStats(db: DatabaseSyncLike, hippoRoot: string): void {
  const legacyIndex = loadLegacyIndexFile(hippoRoot);
  setMeta(db, 'last_retrieval_ids', JSON.stringify(legacyIndex.last_retrieval_ids ?? []));
  // Legacy index.json predates last_trace_id, so '' is normal; accept only a clean digit
  // string rather than trusting a hand-edited or corrupt index.json.
  const legacyTraceId = String(legacyIndex.last_trace_id ?? '');
  setMeta(db, 'last_trace_id', /^\d+$/.test(legacyTraceId) ? legacyTraceId : '');

  const legacyStats = loadLegacyStatsFile(hippoRoot);
  setMeta(db, 'total_remembered', String(Number(legacyStats.total_remembered ?? 0)));
  setMeta(db, 'total_recalled', String(Number(legacyStats.total_recalled ?? 0)));
  setMeta(db, 'total_forgotten', String(Number(legacyStats.total_forgotten ?? 0)));

  const runs = Array.isArray(legacyStats.consolidation_runs) ? legacyStats.consolidation_runs : [];
  const insertRun = db.prepare(`INSERT INTO consolidation_runs(timestamp, decayed, merged, removed) VALUES (?, ?, ?, ?)`);
  for (const run of runs) {
    if (!isJsonObject(run)) continue;
    const row = run;
    insertRun.run(
      String(row.timestamp ?? new Date().toISOString()),
      Number(row.decayed ?? 0),
      Number(row.merged ?? 0),
      Number(row.removed ?? 0)
    );
  }
}

export function loadLegacyEntriesFromMarkdown(hippoRoot: string): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  for (const layer of [Layer.Buffer, Layer.Episodic, Layer.Semantic]) {
    const dir = layerDir(hippoRoot, layer);
    if (!fs.existsSync(dir)) continue;

    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.md')) continue;
      const raw = fs.readFileSync(path.join(dir, file), 'utf8');
      const entry = deserializeEntry(raw);
      if (entry) entries.push(entry);
    }
  }
  return entries;
}

function loadLegacyIndexFile(hippoRoot: string): HippoIndex {
  const indexPath = path.join(hippoRoot, 'index.json');
  if (!fs.existsSync(indexPath)) {
    return { version: 1, entries: {}, last_retrieval_ids: [], last_trace_id: null };
  }

  try {
    // SAFETY: index.json is only ever written by writeIndexMirror below,
    // which always serializes a HippoIndex; a hand-edited or corrupted file
    // that violates the shape falls through to the catch block's fallback.
    return JSON.parse(fs.readFileSync(indexPath, 'utf8')) as HippoIndex;
  } catch (err) {
    log.debug(`store: unreadable index.json read as empty: ${errorMessage(err)}`);
    return { version: 1, entries: {}, last_retrieval_ids: [], last_trace_id: null };
  }
}

function loadLegacyStatsFile(hippoRoot: string): LegacyStats {
  const statsPath = path.join(hippoRoot, 'stats.json');
  if (!fs.existsSync(statsPath)) {
    return {
      total_remembered: 0,
      total_recalled: 0,
      total_forgotten: 0,
      consolidation_runs: [],
    };
  }

  try {
    // SAFETY: stats.json is only ever written by writeStatsMirror below,
    // which always emits exactly these four fields; callers additionally
    // guard every read with `?? 0` / `Array.isArray`, tolerating a
    // hand-edited or corrupted file even if this optimistic cast is wrong.
    return JSON.parse(fs.readFileSync(statsPath, 'utf8')) as LegacyStats;
  } catch (err) {
    log.debug(`store: unreadable stats.json read as zero: ${errorMessage(err)}`);
    return {
      total_remembered: 0,
      total_recalled: 0,
      total_forgotten: 0,
      consolidation_runs: [],
    };
  }
}
