import {
  countTableRows,
  ftsRowCounts,
  getCurrentSchemaVersion,
  getMeta,
  getSchemaVersion,
  type DatabaseSyncLike,
} from '../../../db/index.js';
import { listTableNames } from '../../../db/tables.js';
import { errorMessage } from '../../../base/util/log.js';
import { countFailuresSince } from '../capture/failure-log.js';
import { lastConsolidation } from '../entries/index-and-stats.js';
import type { JsonObject } from '../../../base/util/json.js';
import type {
  Attempt,
  HealthCutoffs,
  StoreHealth,
  StoreInventory,
  CompactionCounts,
  TokenTally,
  Diagnostics,
} from '../../../base/ports/store/diagnostics.js';
import { type OnHandle, readOnly } from '../runtime/open.js';
import { bound, type Bodies } from '../runtime/bound.js';
import { cachedStatement } from '../../../db/statement-cache.js';
import { META_KEY } from '../../../db/meta.js';

function attempt<T>(read: () => T): Attempt<T> {
  try {
    return { ok: true, value: read() };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

function storeHealth(db: DatabaseSyncLike, cutoffs: HealthCutoffs): StoreHealth {
  return {
    schemaVersion: getSchemaVersion(db),
    binarySchemaVersion: getCurrentSchemaVersion(),
    memories: countTableRows(db, 'memories'),
    dormant: countTableRows(db, 'dormant_memories'),
    fts: attempt(() => ftsRowCounts(db)),
    tokens: attempt(() => tokenTallySince(db, cutoffs.since)),
    failures: attempt(() => countFailuresSince(db, cutoffs.since)),
    lastSleep: attempt(() => lastConsolidation(db)),
    compactions: attempt(() => compactionCounts(db, cutoffs.stuckBefore, cutoffs.transcriptFloor)),
  };
}

function storeInventory(db: DatabaseSyncLike): StoreInventory {
  const schemaVersion = getSchemaVersion(db);
  const minCompatibleBinary = getMeta(db, META_KEY.minCompatibleBinary, '') || null;
  const tables: JsonObject = {};
  for (const name of listTableNames(db)) tables[name] = countTableRows(db, name);
  return { schemaVersion, minCompatibleBinary, tables };
}

function compactionCounts(
  db: DatabaseSyncLike,
  stuckBefore: string,
  transcriptFloor: string,
): CompactionCounts {
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

function tokenTallySince(db: DatabaseSyncLike, sinceIso: string): TokenTally {
  const row = cachedStatement(
    db,
    `SELECT COUNT(CASE WHEN event = 'inject' THEN 1 END) AS n,
              COALESCE(SUM(CASE WHEN event = 'inject' THEN tokens END), 0) AS t,
              COALESCE(SUM(CASE WHEN event = 'reread' THEN tokens END), 0) AS r
       FROM token_ledger WHERE ts >= ?`,
  ).get(sinceIso) as { n: number; t: number; r: number } | undefined;
  return {
    injected: Number(row?.n ?? 0),
    tokensSent: Number(row?.t ?? 0),
    tokensReread: Number(row?.r ?? 0),
  };
}

const diagnosticsBodies: Bodies<Diagnostics> = {
  health: storeHealth,
  inventory: storeInventory,
};

export function sqliteDiagnostics(on: OnHandle): Diagnostics {
  return bound(on, diagnosticsBodies, readOnly);
}
