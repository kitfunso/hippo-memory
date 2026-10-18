// hippo.db's side of the dashboard reads: a tenant's live rows a page at a time, with only the columns the lists
// show, SQL counts of the rows left out, and the commit signal on one held read-only connection.
import * as fs from 'fs';
import { closeHippoDb, getHippoDbPath, openHippoDbReadOnly, type DatabaseSyncLike } from '../db/index.js';
import { withReadSnapshot } from '../db/busy.js';
import { pragmaDataVersion } from '../db/meta.js';
import { tableExists } from '../db/tables.js';
import type { Layer, MemoryKind } from '../core/memory.js';
import type { KeysetPosition } from '../util/keyset.js';
import { MAX_LIST_LIMIT } from '../util/limits.js';
import { conflictPageAt, openConflictsNamingAt } from './conflicts.js';
import { openStore, type Handles } from './open.js';
import type {
  DashboardReads,
  DashboardRow,
  DashboardScan,
  DashboardText,
  ExcludedCounts,
} from './port/dashboard-reads.js';
import { QUARANTINE_SCOPE_PREFIX } from './quarantine.js';
import { type MemoryRow, parseJsonArray } from './rows.js';

const PAGE_ROWS = 1000;
// One past the list's 240-character cut, so the cut and its truncated flag come out as they would on the whole text.
const HEAD_CHARS = 241;

const LIVE_COLUMNS =
  'id, created, last_retrieved, retrieval_count, half_life_days, layer, emotional_valence, outcome_positive, ' +
  'outcome_negative, pinned, confidence, superseded_by, kind, scope, origin_project, ' +
  `substr(content, 1, ${HEAD_CHARS}) AS head, ` +
  'EXISTS (SELECT 1 FROM memory_vectors v WHERE v.memory_id = memories.id) AS embedded';
type LiveRow = Pick<
  MemoryRow,
  | 'id'
  | 'created'
  | 'last_retrieved'
  | 'retrieval_count'
  | 'half_life_days'
  | 'layer'
  | 'emotional_valence'
  | 'outcome_positive'
  | 'outcome_negative'
  | 'pinned'
  | 'confidence'
  | 'superseded_by'
  | 'kind'
  | 'scope'
  | 'origin_project'
> & { head: string; embedded: number };

const TEXT_COLUMNS = 'id, created, content, tags_json';
type TextRow = Pick<MemoryRow, 'id' | 'created' | 'content' | 'tags_json'>;

// SQL twins of isQuarantineScope and of the two halves of isLiveMemory; substr compares bytes, as startsWith does,
// where LIKE would fold case.
const QUARANTINED =
  `(scope IS NOT NULL ` + `AND substr(scope, 1, ${QUARANTINE_SCOPE_PREFIX.length}) = '${QUARANTINE_SCOPE_PREFIX}')`;
const SUPERSEDED_BY = `(superseded_by IS NOT NULL AND superseded_by <> '')`;
const KIND = `COALESCE(kind, 'distilled')`;
const LIVE = `NOT ${SUPERSEDED_BY} AND ${KIND} IN ('raw', 'distilled') AND NOT ${QUARANTINED}`;

// The defaults are rowToEntry's, so a row reads the same here as through the full mapper.
function toDashboardRow(row: LiveRow): DashboardRow {
  // SAFETY: layer and kind are columns the write path only fills from those two unions.
  return {
    id: row.id,
    created: row.created,
    last_retrieved: row.last_retrieved,
    retrieval_count: Number(row.retrieval_count ?? 0),
    half_life_days: Number(row.half_life_days ?? 7),
    layer: row.layer as Layer,
    emotional_valence: row.emotional_valence ?? 'neutral',
    outcome_positive: Number(row.outcome_positive ?? 0),
    outcome_negative: Number(row.outcome_negative ?? 0),
    pinned: Boolean(row.pinned),
    confidence: row.confidence ?? 'observed',
    superseded_by: row.superseded_by ?? null,
    kind: (row.kind ?? 'distilled') as MemoryKind,
    scope: row.scope ?? null,
    origin_project: row.origin_project ?? null,
    head: row.head,
    embedded: Boolean(row.embedded),
  };
}

function toDashboardText(row: TextRow): DashboardText {
  const tags = parseJsonArray(row.tags_json, { table: 'memories', id: row.id, column: 'tags_json' });
  return { id: row.id, content: row.content, tags };
}

/** Each page of `columns` over the tenant's live rows by created then id, each page resuming after the last. */
function eachLivePage<R extends { created: string; id: string }>(
  db: DatabaseSyncLike,
  tenantId: string,
  columns: string,
  visit: (page: R[]) => void,
): void {
  const select = `SELECT ${columns} FROM memories WHERE tenant_id = ? AND ${LIVE}`;
  let after: R | undefined;
  for (;;) {
    const keyset = after ? ' AND (created, id) > (?, ?)' : '';
    const params = after ? [tenantId, after.created, after.id, PAGE_ROWS] : [tenantId, PAGE_ROWS];
    // SAFETY: each caller's columns are exactly the fields of its row type R.
    const page = db.prepare(`${select}${keyset} ORDER BY created ASC, id ASC LIMIT ?`).all(...params) as R[];
    if (page.length > 0) visit(page);
    if (page.length < PAGE_ROWS) return;
    after = page[page.length - 1];
  }
}

function eachOpenConflictPage(db: DatabaseSyncLike, tenantId: string, visit: DashboardScan['conflicts']): void {
  let after: KeysetPosition | undefined;
  do {
    const page = conflictPageAt(db, { tenantId, status: 'open', limit: MAX_LIST_LIMIT, after });
    if (page.rows.length > 0) visit(page.rows.map((row) => row.conflict));
    after = page.next ?? undefined;
  } while (after);
}

function excludedAt(db: DatabaseSyncLike, tenantId: string): ExcludedCounts {
  // SAFETY: the SELECT names exactly these two fields, and `why` is one of the three CASE arms or NULL.
  const counts = db
    .prepare(
      `SELECT CASE WHEN ${QUARANTINED} THEN 'quarantined' ` +
        `WHEN ${SUPERSEDED_BY} OR ${KIND} = 'superseded' THEN 'superseded' ` +
        `WHEN ${KIND} = 'archived' THEN 'archived' END AS why, COUNT(*) AS n ` +
        `FROM memories WHERE tenant_id = ? AND NOT (${LIVE}) GROUP BY why`,
    )
    .all(tenantId) as Array<{ why: keyof ExcludedCounts | null; n: number }>;
  const excluded: ExcludedCounts = { superseded: 0, archived: 0, quarantined: 0 };
  for (const { why, n } of counts) if (why !== null) excluded[why] = Number(n);
  return excluded;
}

function scanAt(db: DatabaseSyncLike, tenantId: string, visit: DashboardScan): ExcludedCounts {
  return withReadSnapshot(db, () => {
    eachLivePage<LiveRow>(db, tenantId, LIVE_COLUMNS, (page) => visit.rows(page.map(toDashboardRow)));
    eachOpenConflictPage(db, tenantId, visit.conflicts);
    return excludedAt(db, tenantId);
  });
}

/** Scans run on a fresh writable open, which runs any pending migration and legacy embeddings.json import first; the
 * commit signal and point reads use one read-only connection, opened on the first call that finds a database. */
export function sqliteDashboardReads({ on, files }: Handles): DashboardReads {
  let held: DatabaseSyncLike | null = null;
  const reader = (): DatabaseSyncLike | null => {
    if (held === null && fs.existsSync(getHippoDbPath(files.hippoRoot))) held = openHippoDbReadOnly(files.hippoRoot);
    return held;
  };
  return {
    commitCount() {
      const db = reader();
      return db === null ? null : pragmaDataVersion(db);
    },
    scan: (tenantId, visit) => on((db) => scanAt(db, tenantId, visit), openStore),
    scanText(tenantId, visit) {
      on(
        (db) =>
          withReadSnapshot(db, () => {
            eachLivePage<TextRow>(db, tenantId, TEXT_COLUMNS, (page) => visit(page.map(toDashboardText)));
          }),
        openStore,
      );
    },
    openConflictsOf: (tenantId, memoryId) => on((db) => openConflictsNamingAt(db, tenantId, memoryId), openStore),
    hasVector(id) {
      const db = reader();
      if (db === null || !tableExists(db, 'memory_vectors')) return false;
      return db.prepare('SELECT 1 FROM memory_vectors WHERE memory_id = ?').get(id) !== undefined;
    },
    close() {
      if (held !== null) closeHippoDb(held);
      held = null;
    },
  };
}
