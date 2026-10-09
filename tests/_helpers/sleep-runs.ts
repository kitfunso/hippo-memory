// Counts the consolidation runs a store has logged, one row per finished sleep.
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';

export function sleepRuns(hippoRoot: string): number {
  const db = openHippoDb(hippoRoot);
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM consolidation_runs').get<{ n: number }>().n;
  } finally {
    closeHippoDb(db);
  }
}
