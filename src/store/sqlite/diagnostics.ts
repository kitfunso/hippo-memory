// What `hippo doctor` and `hippo support-bundle` read from a store's handle: plain data out.
import {
  countTableRows,
  ftsRowCounts,
  getCurrentSchemaVersion,
  getMeta,
  getSchemaVersion,
  type DatabaseSyncLike,
  openHippoDbReadOnly,
} from '../../db/index.js';
import { listTableNames } from '../../db/tables.js';
import { errorMessage } from '../../base/util/log.js';
import { countFailuresSince } from './failure-log.js';
import { lastConsolidationAt } from './index-and-stats.js';
import type { JsonObject } from '../../base/util/json.js';
import type {
  Attempt,
  HealthCutoffs,
  StoreHealth,
  StoreInventory,
  CompactionCounts,
  TokenTally,
  Diagnostics,
} from '../port/diagnostics.js';
import type { OnHandle } from './open.js';
import { projectTagReads } from './project-tags.js';
import { bound, type Bodies } from './bound.js';
import { cachedStatement } from '../../db/statement-cache.js';

function attempt<T>(read: () => T): Attempt<T> {
  try {
    return { ok: true, value: read() };
  } catch (err) {
    // The caller turns the message into its own check, so the error stops here.
    return { ok: false, message: errorMessage(err) };
  }
}

/** Everything `hippo doctor` reads from one store; throws when its schema version cannot be read. */
function storeHealthAt(db: DatabaseSyncLike, cutoffs: HealthCutoffs): StoreHealth {
  return {
    schemaVersion: getSchemaVersion(db),
    binarySchemaVersion: getCurrentSchemaVersion(),
    memories: countTableRows(db, 'memories'),
    dormant: countTableRows(db, 'dormant_memories'),
    fts: attempt(() => ftsRowCounts(db)),
    tokens: attempt(() => tokenTallySince(db, cutoffs.since)),
    failures: attempt(() => countFailuresSince(db, cutoffs.since)),
    lastSleep: attempt(() => lastConsolidationAt(db)),
    compactions: attempt(() => compactionCountsAt(db, cutoffs.stuckBefore, cutoffs.transcriptFloor)),
  };
}

/** Schema version, oldest allowed binary and row count of every table, for a support bundle; never reads a memory
 * column. */
function storeInventoryAt(db: DatabaseSyncLike): StoreInventory {
  const schemaVersion = getSchemaVersion(db);
  const minCompatibleBinary = getMeta(db, 'min_compatible_binary', '') || null;
  const tables: JsonObject = {};
  for (const name of listTableNames(db)) tables[name] = countTableRows(db, name);
  return { schemaVersion, minCompatibleBinary, tables };
}

/** Compaction records in all, those with a summary whose memories never got saved, and those still without a summary;
 * each cutoff is an ISO time. */
function compactionCountsAt(db: DatabaseSyncLike, stuckBefore: string, transcriptFloor: string): CompactionCounts {
  const row = cachedStatement(
    db,
    `SELECT COUNT(*) AS total,
              COUNT(CASE WHEN status = 'summarised' AND summarised_at < ? THEN 1 END) AS summarised,
              COUNT(CASE WHEN status = 'started' AND started_at < ? AND started_at > ? AND transcript_path IS NOT NULL
              THEN 1 END) AS started
       FROM compactions`,
  ).get(stuckBefore, stuckBefore, transcriptFloor) as
    | { total: number; summarised: number; started: number }
    | undefined;
  return {
    total: Number(row?.total ?? 0),
    summarised: Number(row?.summarised ?? 0),
    started: Number(row?.started ?? 0),
  };
}

/** Memory blocks injected since `sinceIso`, the tokens they sent and the tokens later model calls re-read. */
function tokenTallySince(db: DatabaseSyncLike, sinceIso: string): TokenTally {
  const row = cachedStatement(
    db,
    `SELECT COUNT(CASE WHEN event = 'inject' THEN 1 END) AS n,
              COALESCE(SUM(CASE WHEN event = 'inject' THEN tokens END), 0) AS t,
              COALESCE(SUM(CASE WHEN event = 'reread' THEN tokens END), 0) AS r
       FROM token_ledger WHERE ts >= ?`,
  ).get(sinceIso) as { n: number; t: number; r: number } | undefined;
  return { injected: Number(row?.n ?? 0), tokensSent: Number(row?.t ?? 0), tokensReread: Number(row?.r ?? 0) };
}

const diagnosticsAt: Bodies<Pick<Diagnostics, 'health' | 'inventory'>> = {
  health: storeHealthAt,
  inventory: storeInventoryAt,
};

export function sqliteDiagnostics(on: OnHandle): Diagnostics {
  return {
    ...bound(on, diagnosticsAt, openHippoDbReadOnly),
    projectTags: (tenantId, read) => on((db) => read(projectTagReads(db, tenantId)), openHippoDbReadOnly),
  };
}
