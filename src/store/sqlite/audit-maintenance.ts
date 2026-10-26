// hippo.db's AuditMaintenance group: the quality audit and repair, object-backed ids, automatic deletes and the audit
// prune.
import { appendAuditEvents, pruneAuditRows } from './audit.js';
import { withBackup } from '../../db/backup.js';
import { withTrialScope, withWriteScope } from '../../db/busy.js';
import type { DatabaseSyncLike } from '../../db/sqlite.js';
import { tableColumns } from '../../db/tables.js';
import { assertBinaryCompatible } from '../../db/migrate.js';
import { dormantSnapshotsByIds, insertDormantRow } from './dormant-rows.js';
import { calculateStrength } from '../../base/memory/strength.js';
import type { MemoryEntry } from '../../base/memory/entry.js';
import { isRepairCandidate, previewDefect, repairDefect, repairKeeps } from '../../base/memory/memory-audit.js';
import {
  deleteEntryCore,
  MEMORY_BACKED_TABLES,
  deleteEntriesInBatches,
  memoriesBackingAmong,
} from './delete-and-batch.js';
import { readEntriesByIds, listPreviewRowsPage, type PreviewRow } from './entry-reads.js';
import { listEntriesWhere } from './entry-filter.js';
import { ftsRowExists } from './entry-row.js';
import { MEMORY_SELECT_COLUMNS, parseJsonArray } from './rows.js';
import { purgeMirrorBestEffort } from './mirrors.js';
import type { StoreFiles, Handles, StoreModel } from './open.js';
import type { QualityRepairResult, QualityRepairIssue, RepairProtection } from '../../base/ports/store/audit.js';
import { openStore } from './handles.js';
import { answered, bound, skipEmpty } from './bound.js';
import type { AuditMaintenance } from '../../base/ports/store.js';
import { withUnmigratedDb } from '../../db/open.js';
import type { EntryCursor } from '../../base/ports/store/types.js';
import { READ_PAGE_ROWS } from '../../base/util/pages.js';
import { getMeta, pragmaUserVersion, setMeta, META_KEY } from '../../db/meta.js';

// Quality repair's issue list: which rows are defects and which of those a protection keeps.

/** The issues among `entries` in their order, each defect kept when `protect` names the row. */
function repairIssues(
  entries: readonly MemoryEntry[],
  parents: ReadonlyMap<string, MemoryEntry>,
  backing: ReadonlySet<string>,
  protect: RepairProtection,
): QualityRepairIssue[] {
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
  if (getMeta(db, META_KEY.fts5Available, '0') === '1') {
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
  const parents = readEntriesByIds(db, ids, tenantId);
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
  return repairIssues(entries, parentsOf(db, tenantId, entries), backing, protect);
}

function planRows(db: DatabaseSyncLike, run: RepairRun): RepairPlan {
  const issues: QualityRepairIssue[] = [];
  let total = 0;
  let after: EntryCursor | undefined;
  do {
    const page = listEntriesWhere(db, { tenantId: run.tenantId }, { limit: READ_PAGE_ROWS, after });
    const entries = page.entries.filter(isRepairCandidate);
    total += entries.length;
    issues.push(
      ...judge(
        db,
        run,
        entries,
        memoriesBackingAmong(
          db,
          entries.map((e) => e.id),
        ),
      ),
    );
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
    const rows = listPreviewRowsPage(db, columns, tenantId, { limit: READ_PAGE_ROWS, afterRowid });
    total += rows.length;
    issues.push(...rows.flatMap(previewIssue));
    if (rows.length < READ_PAGE_ROWS) return { total, issues };
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
  readonly rules: StoreModel;
}

function setAsideIssue(db: DatabaseSyncLike, entry: MemoryEntry, reason: string, move: RepairMove): boolean {
  const { now, backup } = move;
  const actor = 'quality-repair';
  const removed = deleteEntryCore(db, entry.id, entry.tenantId, { actor, automatic: true, suppressForgetAudit: true });
  if (removed === null) return false;
  insertDormantRow(db, {
    entry,
    strength: calculateStrength(entry, now, move.rules.strength),
    reason: 'quality-repair',
    dormantAt: now.toISOString(),
  });
  if (getMeta(db, META_KEY.fts5Available, '0') === '1' && ftsRowExists(db, entry.id)) {
    throw new Error(`Quality repair could not remove the full-text row for ${entry.id}`);
  }
  appendAuditEvents(db, [
    {
      tenantId: entry.tenantId,
      actor,
      op: 'quality_repair',
      targetId: entry.id,
      metadata: { reason, backup },
    },
  ]);
  return true;
}

/** The plan's set-aside rows read again and judged as they stand now, by id; a row gone or changed drops out. */
function rejudgeSetAsides(db: DatabaseSyncLike, run: RepairRun, plan: QualityRepairResult) {
  const ids = plan.issues.filter((issue) => issue.disposition === 'set-aside').map((issue) => issue.id);
  const rows = readEntriesByIds(db, ids, run.tenantId);
  const entries = ids.flatMap((id) => rows.get(id) ?? []).filter(isRepairCandidate);
  const backing = memoriesBackingAmong(
    db,
    entries.map((e) => e.id),
  );
  const issues = new Map(judge(db, run, entries, backing).map((issue) => [issue.id, issue]));
  return { ids: new Set(ids), rows, issues };
}

/** Moves the plan's set-aside rows under the write lock, judging only those again, so the lock never spans the tenant;
 * a writer refuses these defects, so no new one can appear between the plan and the lock. */
function applyPlan(
  db: DatabaseSyncLike,
  run: RepairRun,
  plan: QualityRepairResult,
  backup: string,
  rules: StoreModel,
): QualityRepairResult {
  return withWriteScope(db, 'quality_repair_apply', () => {
    const blockers = capabilityBlockers(db);
    if (blockers.length > 0) throw new Error(`Quality repair capability changed: ${blockers.join('; ')}`);
    const move: RepairMove = { now: rules.clock(), backup, rules };
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

/** Preview by default; apply backs the database up, then moves certain defects `protect` lets go to dormant storage.
 * `db` is opened without running migrations, read-only for a preview. */
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

/** Applies the repair once per store, so stores that predate the quality gate are cleaned on upgrade with no command;
 * null once done. `db` is opened writable without running migrations. */
function repairQualityOnce(
  db: DatabaseSyncLike,
  files: StoreFiles,
  tenantId: string,
  protect: RepairProtection,
): QualityRepairResult | null {
  if (getMeta(db, META_KEY.qualityRepairAuto) === '1') return null;
  // The apply commits the flag with the moves, so a lock taken between them cannot hide what moved.
  const result = repairOn(db, files, { tenantId, protect, apply: true, doneKey: META_KEY.qualityRepairAuto });
  // An unsupported schema changed nothing, so the next run tries again once a migration has run.
  if (result.supported && result.backup === null) setMeta(db, META_KEY.qualityRepairAuto, '1');
  return result;
}

export function sqliteAuditMaintenance({ on, files }: Handles): AuditMaintenance {
  const { deleteAutomatically } = bound<Pick<AuditMaintenance, 'deleteAutomatically'>>(
    on,
    {
      deleteAutomatically: (db, removals, actor) => {
        const went = deleteEntriesInBatches(db, files, removals, { actor, automatic: true });
        return removals.filter((_, i) => went[i]).map((removal) => removal.id);
      },
    },
    openStore,
  );
  const reads = bound<Pick<AuditMaintenance, 'objectBackedAmong' | 'pruneAuditRows'>>(on, {
    objectBackedAmong: memoriesBackingAmong,
    pruneAuditRows: pruneAuditRows,
  });
  return {
    ...reads,
    objectBackedAmong: skipEmpty(reads.objectBackedAmong, () => new Set<string>()),
    deleteAutomatically: skipEmpty(deleteAutomatically, () => []),
    // Quality repair opens the store unmigrated, so it opens its own handle from the folder.
    repairQuality: (tenantId, apply, protect) =>
      answered(() =>
        withUnmigratedDb(files.hippoRoot, { readOnly: !apply, grant: files.opens.grant }, (db) =>
          repairOn(db, files, { tenantId, apply, protect }),
        ),
      ),
    repairQualityOnce: (tenantId, protect) =>
      answered(() =>
        withUnmigratedDb(files.hippoRoot, { readOnly: false, grant: files.opens.grant }, (db) =>
          repairQualityOnce(db, files, tenantId, protect),
        ),
      ),
  };
}
