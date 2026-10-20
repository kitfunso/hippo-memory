// hippo.db's AuditMaintenance group: the quality audit and repair, object-backed ids, automatic deletes and the audit
// prune.
import { appendAuditEvent, pruneAuditRowsAt } from './audit.js';
import { withBackup } from '../../db/backup.js';
import { withTrialScope, withWriteScope } from '../../db/busy.js';
import type { DatabaseSyncLike } from '../../db/sqlite.js';
import { getMeta, pragmaUserVersion, setMeta } from '../../db/meta.js';
import { tableColumns } from '../../db/tables.js';
import { assertBinaryCompatible } from '../../db/migrate.js';
import { dormantSnapshotsByIds, insertDormantRow } from './dormant-rows.js';
import { calculateStrength, type LossAversion, type MemoryEntry } from '../../core/memory.js';
import { isRepairCandidate, previewDefect, repairDefect, repairKeeps } from '../../core/memory-audit.js';
import {
  deleteEntryCore,
  MEMORY_BACKED_TABLES,
  deleteEntriesAutomaticallyAt,
  memoriesBackingObjectsAt,
} from './delete-and-batch.js';
import { loadEntriesPageAt, selectEntriesByIds, selectPreviewRowsPage, type PreviewRow } from './entry-reads.js';
import { ftsRowExists } from './entry-row.js';
import { MEMORY_SELECT_COLUMNS, parseJsonArray } from './rows.js';
import { purgeMirrorBestEffort } from './mirrors.js';
import type { StoreFiles, Handles } from './open.js';
import type { QualityRepairResult, QualityRepairIssue, RepairProtection } from '../port/audit-maintenance.js';
import { openStore } from './handles.js';
import { bound, boundWithFiles, skipEmpty } from './bound.js';
import type { AuditMaintenance } from '../port.js';
import type { Sync } from './served.js';
import { withUnmigratedDb } from '../../db/open.js';
import type { EntryCursor } from '../port/types.js';

const PLAN_PAGE_ROWS = 500;

/** The rows a repair judged and the issues it found among them, in store order. */
interface RepairPlan {
  readonly total: number;
  readonly issues: QualityRepairIssue[];
}

const REQUIRED_COLUMNS = {
  memories: MEMORY_SELECT_COLUMNS.split(',').map((s) => s.trim()),
  meta: ['key', 'value'],
  dormant_memories: ['tenant_id', 'id', 'content', 'entry_json', 'reason', 'strength', 'dormant_at'],
  audit_log: ['ts', 'tenant_id', 'actor', 'op', 'target_id', 'metadata_json'],
  ...Object.fromEntries(MEMORY_BACKED_TABLES.map((table) => [table, ['memory_id']])),
} satisfies Record<string, readonly string[]>;

function capabilityBlockers(db: DatabaseSyncLike): string[] {
  const blockers: string[] = [];
  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    const columns = tableColumns(db, table);
    if (columns.size === 0) blockers.push(`missing table: ${table}`);
    else for (const column of required) if (!columns.has(column)) blockers.push(`missing column: ${table}.${column}`);
  }
  if (blockers.some((blocker) => blocker === 'missing table: meta' || blocker.startsWith('missing column: meta.'))) {
    return blockers;
  }
  assertBinaryCompatible(db);
  if (getMeta(db, 'fts5_available', '0') === '1') {
    const columns = tableColumns(db, 'memories_fts');
    for (const column of ['id', 'content', 'tags']) {
      if (!columns.has(column)) blockers.push(`missing column: memories_fts.${column}`);
    }
  }
  return blockers;
}

interface RepairRun {
  readonly tenantId: string;
  readonly protect: RepairProtection;
  readonly apply?: boolean;
  readonly doneKey?: string;
}

/** Each parent the rows name, read by id: the live row, else its dormant snapshot. */
function parentsOf(db: DatabaseSyncLike, tenantId: string, entries: readonly MemoryEntry[]): Map<string, MemoryEntry> {
  const ids = [...new Set(entries.flatMap((entry) => entry.parents))];
  const parents = selectEntriesByIds(db, ids, tenantId);
  const gone = ids.filter((id) => !parents.has(id));
  for (const [id, snapshot] of dormantSnapshotsByIds(db, tenantId, gone)) parents.set(id, snapshot.entry);
  return parents;
}

/** The issues among `entries` in their order, each defect kept when `protect` names the row. */
function judge(
  db: DatabaseSyncLike,
  { tenantId, protect }: RepairRun,
  entries: readonly MemoryEntry[],
  backing: ReadonlySet<string>,
): QualityRepairIssue[] {
  const parents = parentsOf(db, tenantId, entries);
  return entries.flatMap((entry): QualityRepairIssue[] => {
    const defect = repairDefect(entry, parents);
    if (defect === null) return [];
    const kept = repairKeeps(entry, backing.has(entry.id), protect);
    return [
      kept === undefined
        ? { id: entry.id, ...defect }
        : { id: entry.id, ...defect, disposition: 'protected', protection: kept },
    ];
  });
}

function planRows(db: DatabaseSyncLike, run: RepairRun): RepairPlan {
  const backing = memoriesBackingObjectsAt(db);
  const issues: QualityRepairIssue[] = [];
  let total = 0;
  let after: EntryCursor | undefined;
  do {
    const page = loadEntriesPageAt(db, run.tenantId, { limit: PLAN_PAGE_ROWS, after });
    const entries = page.entries.filter(isRepairCandidate);
    total += entries.length;
    issues.push(...judge(db, run, entries, backing));
    after = page.next ?? undefined;
  } while (after);
  return { total, issues };
}

function previewIssue(row: PreviewRow): QualityRepairIssue[] {
  const tags = parseJsonArray(row.tags_json, { table: 'memories', id: row.id, column: 'tags_json' });
  const reason = previewDefect({
    content: row.content,
    source: row.source ?? '',
    confidence: row.confidence ?? 'observed',
    extractedFrom: row.extracted_from,
    dagLevel: row.dag_level ?? 0,
    tags,
  });
  return reason === null
    ? []
    : [{ id: row.id, reason, disposition: 'review', protection: 'unsupported schema; no changes permitted' }];
}

function unsupportedPreview(db: DatabaseSyncLike, tenantId: string): RepairPlan {
  const columns = tableColumns(db, 'memories');
  if (!columns.has('id') || !columns.has('content')) return { total: 0, issues: [] };
  const issues: QualityRepairIssue[] = [];
  let total = 0;
  // Hippo never names a rowid on insert, so every row's rowid is above 0.
  let afterRowid = 0;
  for (;;) {
    const rows = selectPreviewRowsPage(db, columns, tenantId, { limit: PLAN_PAGE_ROWS, afterRowid });
    total += rows.length;
    issues.push(...rows.flatMap(previewIssue));
    if (rows.length < PLAN_PAGE_ROWS) return { total, issues };
    afterRowid = rows[rows.length - 1].row_id;
  }
}

function plannedResult(db: DatabaseSyncLike, root: string, run: RepairRun): QualityRepairResult {
  const blockers = capabilityBlockers(db);
  const schema = pragmaUserVersion(db);
  const plan = blockers.length > 0 ? unsupportedPreview(db, run.tenantId) : planRows(db, run);
  return {
    root,
    schema,
    supported: blockers.length === 0,
    blockers,
    total: plan.total,
    issues: plan.issues,
    appliedIds: [],
    backup: null,
    warnings: [],
  };
}

// No rejection record, as in project repair: the writers refuse these defects themselves, and a record would also
// refuse a person's copy.
/** When a repair moves its rows, the backup it took first, and the ratio the store scores strength by. */
interface RepairMove {
  readonly now: Date;
  readonly backup: string;
  readonly rules: LossAversion;
}

function setAsideIssue(db: DatabaseSyncLike, entry: MemoryEntry, reason: string, move: RepairMove): boolean {
  const { now, backup } = move;
  const actor = 'quality-repair';
  const removed = deleteEntryCore(db, entry.id, entry.tenantId, { actor, automatic: true, suppressForgetAudit: true });
  if (removed === null) return false;
  insertDormantRow(db, {
    entry,
    strength: calculateStrength(entry, now, move.rules),
    reason: 'quality-repair',
    dormantAt: now.toISOString(),
  });
  if (getMeta(db, 'fts5_available', '0') === '1' && ftsRowExists(db, entry.id)) {
    throw new Error(`Quality repair could not remove the full-text row for ${entry.id}`);
  }
  appendAuditEvent(db, {
    tenantId: entry.tenantId,
    actor,
    op: 'quality_repair',
    targetId: entry.id,
    metadata: { reason, backup },
  });
  return true;
}

/** The plan's set-aside rows read again and judged as they stand now, by id; a row gone or changed drops out. */
function rejudgeSetAsides(db: DatabaseSyncLike, run: RepairRun, plan: QualityRepairResult) {
  const ids = plan.issues.filter((issue) => issue.disposition === 'set-aside').map((issue) => issue.id);
  const rows = selectEntriesByIds(db, ids, run.tenantId);
  const entries = ids.flatMap((id) => rows.get(id) ?? []).filter(isRepairCandidate);
  const issues = new Map(judge(db, run, entries, memoriesBackingObjectsAt(db)).map((issue) => [issue.id, issue]));
  return { ids: new Set(ids), rows, issues };
}

/** Moves the plan's set-aside rows under the write lock, judging only those again, so the lock never spans the tenant;
 * a writer refuses these defects, so no new one can appear between the plan and the lock. */
function applyPlan(
  db: DatabaseSyncLike,
  run: RepairRun,
  plan: QualityRepairResult,
  backup: string,
  rules: LossAversion,
): QualityRepairResult {
  return withWriteScope(db, 'quality_repair_apply', () => {
    const blockers = capabilityBlockers(db);
    if (blockers.length > 0) throw new Error(`Quality repair capability changed: ${blockers.join('; ')}`);
    const move: RepairMove = { now: new Date(), backup, rules };
    const { ids, rows, issues: current } = rejudgeSetAsides(db, run, plan);
    const issues = plan.issues.flatMap((issue) => (ids.has(issue.id) ? (current.get(issue.id) ?? []) : [issue]));
    const appliedIds: string[] = [];
    const warnings: string[] = [];
    for (const issue of issues) {
      if (issue.disposition !== 'set-aside') continue;
      if (setAsideIssue(db, rows.get(issue.id)!, issue.reason, move)) appliedIds.push(issue.id);
      else warnings.push(`Kept ${issue.id}: the store's delete guard protects it.`);
    }
    if (run.doneKey) setMeta(db, run.doneKey, '1');
    return { ...plan, issues, appliedIds, backup, warnings };
  });
}

function repairOn(db: DatabaseSyncLike, files: StoreFiles, run: RepairRun): QualityRepairResult {
  const root = files.hippoRoot;
  const initial = withTrialScope(db, 'quality_repair_plan', () => plannedResult(db, root, run));
  if (!run.apply || !initial.supported || !initial.issues.some((issue) => issue.disposition === 'set-aside')) {
    return initial;
  }
  db.exec('PRAGMA foreign_keys = ON');
  const result = withBackup(db, root, 'before-quality-repair', (backup) => applyPlan(db, run, initial, backup, files));
  const warnings = [...result.warnings];
  for (const id of result.appliedIds) {
    if (purgeMirrorBestEffort(root, id, false, 'quality repair')) continue;
    warnings.push(`Mirror cleanup failed for ${id}; remove its stale mirror before rebuilding the index.`);
  }
  return { ...result, warnings };
}

/** Preview by default; apply backs the database up, then moves certain defects `protect` lets go to dormant storage.
 * `db` is opened without running migrations, read-only for a preview. */
function repairAutomaticMemoriesAt(
  db: DatabaseSyncLike,
  files: StoreFiles,
  opts: { tenantId: string; protect: RepairProtection; apply?: boolean },
): QualityRepairResult {
  return repairOn(db, files, opts);
}

const AUTO_REPAIR_META_KEY = 'quality_repair_auto';

/** Applies the repair once per store, so stores that predate the quality gate are cleaned on upgrade with no command;
 * null once done. `db` is opened writable without running migrations. */
function repairQualityOnceAt(
  db: DatabaseSyncLike,
  files: StoreFiles,
  tenantId: string,
  protect: RepairProtection,
): QualityRepairResult | null {
  if (getMeta(db, AUTO_REPAIR_META_KEY) === '1') return null;
  // The apply commits the flag with the moves, so a lock taken between them cannot hide what moved.
  const result = repairOn(db, files, { tenantId, protect, apply: true, doneKey: AUTO_REPAIR_META_KEY });
  // An unsupported schema changed nothing, so the next run tries again once a migration has run.
  if (result.supported && result.backup === null) setMeta(db, AUTO_REPAIR_META_KEY, '1');
  return result;
}

export function sqliteAuditMaintenance({ on, files }: Handles): Sync<AuditMaintenance> {
  const { deleteAutomatically } = boundWithFiles<Pick<AuditMaintenance, 'deleteAutomatically'>>(
    on,
    { deleteAutomatically: deleteEntriesAutomaticallyAt },
    openStore,
  );
  return {
    ...bound<Pick<AuditMaintenance, 'objectBackedIds' | 'pruneAuditRows'>>(on, {
      objectBackedIds: memoriesBackingObjectsAt,
      pruneAuditRows: pruneAuditRowsAt,
    }),
    deleteAutomatically: skipEmpty(deleteAutomatically, () => []),
    // Quality repair opens the store unmigrated, so it opens its own handle from the folder.
    repairQuality: (tenantId, apply, protect) =>
      withUnmigratedDb(files.hippoRoot, !apply, (db) =>
        repairAutomaticMemoriesAt(db, files, { tenantId, apply, protect }),
      ),
    repairQualityOnce: (tenantId, protect) =>
      withUnmigratedDb(files.hippoRoot, false, (db) => repairQualityOnceAt(db, files, tenantId, protect)),
  };
}
