// What `hippo doctor` and `hippo support-bundle` read from a store's handle: plain data out.
import { countTableRows, ftsRowCounts, getMeta, getSchemaVersion, type DatabaseSyncLike } from '../db/index.js';
import { listTableNames } from '../db/tables.js';
import { errorMessage } from '../util/log.js';
import { compactionCountsAt, tokenTallySince } from './doctor-reads.js';
import { countFailuresSince } from './failure-log.js';
import { lastConsolidationAt } from './sqlite/index-and-stats.js';
import type { JsonObject } from './port/types.js';
import type { Attempt, HealthCutoffs, StoreHealth, StoreInventory } from './port/diagnostics.js';

function attempt<T>(read: () => T): Attempt<T> {
  try {
    return { ok: true, value: read() };
  } catch (err) {
    // The caller turns the message into its own check, so the error stops here.
    return { ok: false, message: errorMessage(err) };
  }
}

/** Everything `hippo doctor` reads from one store; throws when its schema version cannot be read. */
export function storeHealthAt(db: DatabaseSyncLike, cutoffs: HealthCutoffs): StoreHealth {
  return {
    schemaVersion: getSchemaVersion(db),
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
export function storeInventoryAt(db: DatabaseSyncLike): StoreInventory {
  const schemaVersion = getSchemaVersion(db);
  const minCompatibleBinary = getMeta(db, 'min_compatible_binary', '') || null;
  const tables: JsonObject = {};
  for (const name of listTableNames(db)) tables[name] = countTableRows(db, name);
  return { schemaVersion, minCompatibleBinary, tables };
}
