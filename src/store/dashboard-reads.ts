// The dashboard snapshot's read of one tenant: live rows with only the columns it shows, and SQL counts of the rows it leaves out.
import * as fs from 'fs';
import { closeHippoDb, getHippoDbPath, openHippoDbReadOnly, type DatabaseSyncLike } from '../db/index.js';
import { withReadSnapshot } from '../db/busy.js';
import { pragmaDataVersion } from '../db/meta.js';
import { tableExists } from '../db/tables.js';
import { storedVectorIds } from '../db/vector-store.js';
import type { ConfidenceInputs, Layer, MemoryEntry, MemoryKind, StrengthInputs } from '../core/memory.js';
import { onHandle, openStore } from './open.js';
import { QUARANTINE_SCOPE_PREFIX } from './quarantine.js';
import { type MemoryRow, parseJsonArray } from './rows.js';

export type DashboardRow = StrengthInputs & ConfidenceInputs
  & Pick<MemoryEntry, 'id' | 'content' | 'tags' | 'layer' | 'scope' | 'origin_project' | 'kind' | 'superseded_by'>;

export interface ExcludedCounts {
  superseded: number;
  archived: number;
  quarantined: number;
}

export interface DashboardRows {
  /** Rows `isLiveMemory` admits, by created then id as `loadAllEntries` orders them. */
  readonly live: DashboardRow[];
  /** Every other row of the tenant, counted under the first of quarantined, superseded and archived that fits it. */
  readonly excluded: ExcludedCounts;
}

const LIVE_COLUMNS = 'id, created, last_retrieved, retrieval_count, half_life_days, layer, tags_json, emotional_valence, outcome_positive, outcome_negative, pinned, confidence, content, superseded_by, kind, scope, origin_project';
type LiveRow = Pick<
  MemoryRow,
  'id' | 'created' | 'last_retrieved' | 'retrieval_count' | 'half_life_days' | 'layer' | 'tags_json' | 'emotional_valence' | 'outcome_positive'
  | 'outcome_negative' | 'pinned' | 'confidence' | 'content' | 'superseded_by' | 'kind' | 'scope' | 'origin_project'
>;

// SQL twins of isQuarantineScope and of the two halves of isLiveMemory; substr compares bytes, as startsWith does, where LIKE would fold case.
const QUARANTINED = `(scope IS NOT NULL AND substr(scope, 1, ${QUARANTINE_SCOPE_PREFIX.length}) = '${QUARANTINE_SCOPE_PREFIX}')`;
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
    tags: parseJsonArray(row.tags_json, { table: 'memories', id: row.id, column: 'tags_json' }),
    emotional_valence: row.emotional_valence ?? 'neutral',
    outcome_positive: Number(row.outcome_positive ?? 0),
    outcome_negative: Number(row.outcome_negative ?? 0),
    pinned: Boolean(row.pinned),
    confidence: row.confidence ?? 'observed',
    content: row.content,
    superseded_by: row.superseded_by ?? null,
    kind: (row.kind ?? 'distilled') as MemoryKind,
    scope: row.scope ?? null,
    origin_project: row.origin_project ?? null,
  };
}

/** One tenant's live rows and the counts of the rest, read in one transaction so the two agree. */
export function loadDashboardRows(hippoRoot: string, tenantId: string): DashboardRows {
  return onHandle(hippoRoot, (db) => {
    return withReadSnapshot(db, () => {
      // SAFETY: the SELECT names exactly LiveRow's columns.
      const live = db.prepare(`SELECT ${LIVE_COLUMNS} FROM memories WHERE tenant_id = ? AND ${LIVE} ORDER BY created ASC, id ASC`).all(tenantId) as LiveRow[];
      // SAFETY: the SELECT names exactly these two fields, and `why` is one of the three CASE arms or NULL.
      const counts = db.prepare(`
        SELECT CASE WHEN ${QUARANTINED} THEN 'quarantined' WHEN ${SUPERSEDED_BY} OR ${KIND} = 'superseded' THEN 'superseded' WHEN ${KIND} = 'archived' THEN 'archived' END AS why,
               COUNT(*) AS n
        FROM memories WHERE tenant_id = ? AND NOT (${LIVE}) GROUP BY why
      `).all(tenantId) as Array<{ why: keyof ExcludedCounts | null; n: number }>;
      const excluded: ExcludedCounts = { superseded: 0, archived: 0, quarantined: 0 };
      for (const { why, n } of counts) if (why !== null) excluded[why] = Number(n);
      return { live: live.map(toDashboardRow), excluded };
    });
  }, openStore);
}

/** The dashboard's one read-only connection, kept across refreshes for the commit signal; it opens on the first read that finds a database. */
export class DashboardConnection {
  private db: DatabaseSyncLike | null = null;

  constructor(private readonly hippoRoot: string) {}

  /** `PRAGMA data_version`, which moves when another connection commits; null while the store has no hippo.db. */
  dataVersion(): number | null {
    if (this.db === null) {
      if (!fs.existsSync(getHippoDbPath(this.hippoRoot))) return null;
      this.db = openHippoDbReadOnly(this.hippoRoot);
    }
    return pragmaDataVersion(this.db);
  }

  /** Ids with a stored vector: none before the connection opens, null on a store older than the vector table (schema v52). */
  embeddedIds(): ReadonlySet<string> | null {
    if (this.db === null) return new Set();
    return tableExists(this.db, 'memory_vectors') ? storedVectorIds(this.db) : null;
  }

  close(): void {
    if (this.db !== null) closeHippoDb(this.db);
    this.db = null;
  }
}
