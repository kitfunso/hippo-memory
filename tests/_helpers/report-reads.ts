// The status reports as the scorecard tests read them: through sqliteStore's reports group.
import type { MemoryEntry } from '../../src/base/memory/memory.js';
import type { CorrectionLink, RawProvenancePage } from '../../src/base/ports/store/reports.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { makeRoot } from './make-root.js';
import { writeEntry } from './root-forms.js';

const PAGE = { limit: 500 };

export const rawProvenanceAt = (root: string): Promise<RawProvenancePage> =>
  sqliteStore(root).reports.rawProvenance(PAGE);

/** The links a fresh store gives for `rows`, written as they are, and read back through the join. */
export async function correctionLinksOfRows(rows: readonly MemoryEntry[]): Promise<CorrectionLink[]> {
  const root = makeRoot('report-links');
  for (const row of rows) writeEntry(root, row);
  return (await sqliteStore(root).reports.correctionLinks(PAGE)).links;
}
