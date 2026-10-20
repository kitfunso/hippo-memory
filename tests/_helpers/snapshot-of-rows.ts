import { createSnapshotService, type Snapshot } from '../../src/api/dashboard/snapshot.js';

type Reads = Parameters<typeof createSnapshotService>[0];
type Scan = Parameters<Reads['scan']>[1];

/** The snapshot the dashboard's service builds when the store's scan answers `rows` (by created then id, live or not)
 *  and `openConflicts`, dated `nowMs`. */
export function snapshotOfRows(
  nowMs: number,
  rows: Parameters<Scan['rows']>[0],
  openConflicts: Parameters<Scan['conflicts']>[0] = [],
): Snapshot {
  const reads: Reads = {
    commitCount: () => 0,
    scan: (_tenantId, visit) => {
      visit.rows(rows);
      visit.conflicts(openConflicts);
      return { superseded: 0, archived: 0, quarantined: 0 };
    },
    scanText: () => {},
    openConflictsOf: () => [],
    hasVector: () => false,
    close: () => {},
  };
  return createSnapshotService(reads, {}, () => nowMs).get('default');
}
