// Opens the SQLite store, the source of truth; Markdown and JSON files are human-readable mirrors of it.

import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_HALF_LIFE_DAYS, type MemoryEntry, Layer } from '../memory.js';
import { closeHippoDb, type DatabaseSyncLike, openHippoDb, getMeta, setMeta } from '../db.js';
import { type ResolveProjectIdentityOpts, findHippoStoreDir, realpathOrResolve } from '../project-identity.js';
import { RejectedValueError } from '../rejection.js';
import { log } from '../log.js';
import { type HippoIndex, type LegacyStats, isPlainJsonObject } from './rows.js';
import { audit } from './audit-event.js';
import { deserializeEntry } from './markdown.js';
import { stampOriginProjectForImport, upsertEntryRow } from './entry-row.js';
import { ensureMirrorDirectories, syncMirrorFiles, layerDir } from './mirrors.js';

/** Nearest ancestor store like git; the strict join is the fallback so `hippo init` still creates `<cwd>/.hippo`. */
export function getHippoRoot(cwd: string = process.cwd(), opts?: ResolveProjectIdentityOpts): string {
  return findHippoStoreDir(cwd, opts) ?? path.join(realpathOrResolve(cwd), '.hippo');
}

export function isInitialized(hippoRoot: string): boolean {
  // A bare .hippo directory is not enough — autoInstallHooks /
  // setupDailySchedule can create it without ever calling initStore,
  // leaving a partial directory (integrations/, logs/, runs/) with no
  // hippo.db. Returning true in that state caused `hippo init` to skip
  // initStore and `hippo recall` to silently fall back to an empty store
  // (incident 2026-04-26: ingest_direct.py against a bare .hippo).
  // Treat the store as initialized only if hippo.db actually exists.
  return fs.existsSync(path.join(hippoRoot, 'hippo.db'));
}

export function initStore(hippoRoot: string): void {
  closeHippoDb(openStore(hippoRoot));
}

/** One open connection with init done on it, for callers who used to pay for `initStore` + a second `openHippoDb`. */
export function openStore(hippoRoot: string): DatabaseSyncLike {
  ensureMirrorDirectories(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
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

/** `meta` key holding the default half-life base a store's memories are on (src/half-life-migration.ts). */
export const HALF_LIFE_BASE_META_KEY = 'default_half_life_base';
/** `meta` key set once no memory of a decision, incident or other object sits on the old flat 90 days. */
export const TYPED_HALF_LIFE_META_KEY = 'typed_half_life_on_default';

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
  // SAFETY: countRow's shape matches the single `COUNT(*) AS count` column
  // selected above; `.get()` returns undefined only when no row exists.
  const countRow = db.prepare(`SELECT COUNT(*) AS count FROM memories`).get() as { count?: number } | undefined;
  const memoryCount = Number(countRow?.count ?? 0);
  if (memoryCount > 0) return false;
  // AT1 P2 fix: memoryCount alone is not a reliable "already bootstrapped"
  // signal once the rejection guard exists. If EVERY legacy mirror row is
  // rejected, memories stays at 0 rows even after a successful bootstrap
  // pass, so the memoryCount>0 gate above never trips — every subsequent
  // initStore() call would re-run this whole function: re-scan the legacy
  // mirrors, re-attempt (and re-refuse, re-auditing) every row, and
  // re-INSERT the legacy consolidation_runs rows with no dedup, duplicating
  // them on each open. A dedicated meta flag marks bootstrap as
  // attempted-and-settled regardless of how many rows actually landed.
  if (getMeta(db, 'legacy_bootstrap_completed', '0') === '1') return false;

  const legacyEntries = loadLegacyEntriesFromMarkdown(hippoRoot);
  if (legacyEntries.length === 0) return false;

  db.exec('BEGIN');
  try {
    // AT1 (plan §3, round-3 redesign): run the guard LIVE per row rather
    // than bypassing it. bootstrapLegacyStore is exactly the channel through
    // which a stale/never-purged markdown mirror could resurrect a rejected
    // value; a skip-and-count here closes that structurally, independent of
    // mirror state. The refusal audit is written INLINE inside this
    // still-open loop transaction (plain audit() — nothing is rolled back
    // on a per-row skip, so the post-rollback auditRejectionRefusal helper
    // is the wrong tool here).
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
          audit(db, 'reject_refusal', err.entryId, { digest: err.digest, reason: err.reason }, 'cli', err.tenantId);
          continue;
        }
        throw err;
      }
    }
    if (rejectedCount > 0) {
      log.warn(`bootstrapLegacyStore: skipped ${rejectedCount} rejected value(s) found in legacy mirrors`);
    }

    const legacyIndex = loadLegacyIndexFile(hippoRoot);
    setMeta(db, 'last_retrieval_ids', JSON.stringify(legacyIndex.last_retrieval_ids ?? []));
    // LC1: legacy index.json predates last_trace_id, so this is '' for every
    // pre-v40 store — harmless, matches the ensureMetaDefaults default.
    // Coerce like its neighbors below coerce theirs (independent-review-critic
    // LOW finding): accept only a clean digit string, else fall back to ''
    // rather than trusting whatever a hand-edited/corrupt index.json carries.
    const legacyTraceId = String(legacyIndex.last_trace_id ?? '');
    setMeta(db, 'last_trace_id', /^\d+$/.test(legacyTraceId) ? legacyTraceId : '');

    const legacyStats = loadLegacyStatsFile(hippoRoot);
    setMeta(db, 'total_remembered', String(Number(legacyStats.total_remembered ?? 0)));
    setMeta(db, 'total_recalled', String(Number(legacyStats.total_recalled ?? 0)));
    setMeta(db, 'total_forgotten', String(Number(legacyStats.total_forgotten ?? 0)));

    const runs = Array.isArray(legacyStats.consolidation_runs) ? legacyStats.consolidation_runs : [];
    const insertRun = db.prepare(`INSERT INTO consolidation_runs(timestamp, decayed, merged, removed) VALUES (?, ?, ?, ?)`);
    for (const run of runs) {
      if (!isPlainJsonObject(run)) continue;
      const row = run;
      insertRun.run(
        String(row.timestamp ?? new Date().toISOString()),
        Number(row.decayed ?? 0),
        Number(row.merged ?? 0),
        Number(row.removed ?? 0)
      );
    }

    // AT1 P2 fix: stamp completion regardless of how many rows actually
    // landed (all-rejected included) — see the gate comment above.
    setMeta(db, 'legacy_bootstrap_completed', '1');
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back; keep the original error */ }
    throw error;
  }
  return true;
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
    log.debug(`store: unreadable index.json read as empty: ${err instanceof Error ? err.message : String(err)}`);
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
    log.debug(`store: unreadable stats.json read as zero: ${err instanceof Error ? err.message : String(err)}`);
    return {
      total_remembered: 0,
      total_recalled: 0,
      total_forgotten: 0,
      consolidation_runs: [],
    };
  }
}
