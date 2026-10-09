import fs from 'node:fs';
import path from 'node:path';
import { appendAuditEvent } from '../store/audit.js';
import { withBackup } from '../db/backup.js';
import { withTrialScope, withWriteScope } from '../db/busy.js';
import { assertSqliteAllowed } from '../db/open.js';
import { DatabaseSync, type DatabaseSyncLike } from '../db/sqlite.js';
import { getMeta, pragmaUserVersion, setMeta } from '../db/meta.js';
import { tableColumns } from '../db/tables.js';
import { assertBinaryCompatible } from '../db/migrate.js';
import { insertDormantRow, listDormantSnapshots } from '../store/dormant.js';
import { calculateStrength, canAutoDelete, type MemoryEntry } from '../core/memory.js';
import { assessAutomaticMemory, BUNDLE_HEADER, isAutomaticEntry, isCertainReason, type AutomaticMemoryDefect } from '../core/memory-quality.js';
import { heldTexts } from '../util/same-text.js';
import { deleteEntryCore, MEMORY_BACKED_TABLES, memoriesBackingObjectsOn } from '../store/delete-and-batch.js';
import { selectAllEntries, selectPreviewRows } from '../store/entry-reads.js';
import { ftsRowExists } from '../store/entry-row.js';
import { MEMORY_SELECT_COLUMNS, parseJsonArray } from '../store/rows.js';
import { purgeMirrorBestEffort } from '../store/mirrors.js';

/** One automatic row with a defect. `set-aside` moves to dormant storage on apply, `review` is listed only, `protected` is kept. */
export interface QualityRepairIssue {
  readonly id: string;
  readonly reason: string;
  readonly disposition: 'set-aside' | 'review' | 'protected';
  readonly protection?: string;
}

/** One tenant's plan; `supported` is false, with `blockers` naming each gap, when the schema cannot be changed safely. */
export interface QualityRepairResult {
  readonly root: string;
  readonly schema: number;
  readonly supported: boolean;
  readonly blockers: readonly string[];
  readonly total: number;
  readonly issues: readonly QualityRepairIssue[];
  readonly appliedIds: readonly string[];
  readonly backup: string | null;
  readonly warnings: readonly string[];
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
  if (blockers.some((blocker) => blocker === 'missing table: meta' || blocker.startsWith('missing column: meta.'))) return blockers;
  assertBinaryCompatible(db);
  if (getMeta(db, 'fts5_available', '0') === '1') {
    const columns = tableColumns(db, 'memories_fts');
    for (const column of ['id', 'content', 'tags']) {
      if (!columns.has(column)) blockers.push(`missing column: memories_fts.${column}`);
    }
  }
  return blockers;
}

function protection(entry: MemoryEntry, backing: ReadonlySet<string>): string | undefined {
  if (entry.pinned) return 'pinned';
  if (entry.kind === 'raw') return 'raw receipt';
  if (!canAutoDelete(entry)) return 'trusted imported note';
  if (backing.has(entry.id)) return 'backs an object';
  return undefined;
}

function structured(entry: MemoryEntry): boolean {
  return entry.trace_outcome !== null || entry.tags.includes('session-digest') || entry.source === 'auto-promote';
}

/** A parent that is gone says nothing about who wrote it, so it counts as a person's. */
function fromAutomaticParents(entry: MemoryEntry, rows: ReadonlyMap<string, MemoryEntry>): boolean {
  return entry.parents.length > 0 && entry.parents.every((id) => {
    const parent = rows.get(id);
    return parent !== undefined && isAutomaticEntry(parent);
  });
}

function contentIssue(entry: MemoryEntry, rows: ReadonlyMap<string, MemoryEntry>): Omit<QualityRepairIssue, 'id'> | null {
  if (structured(entry) || !isAutomaticEntry(entry)) return null;
  // Only a bundle header marks parts; a refined row keeps its lead line, so it is judged whole.
  if (!BUNDLE_HEADER.test(entry.content)) {
    const { reason } = assessAutomaticMemory(entry.content);
    return reason === null ? null : { reason, disposition: isCertainReason(reason) ? 'set-aside' : 'review' };
  }
  const texts = heldTexts({ ...entry, source: 'consolidation' });
  if (texts.length === 0) return { reason: 'derived bundle has no safely parsed constituents', disposition: 'review' };
  const reasons = texts.map((text) => assessAutomaticMemory(text).reason).filter((reason): reason is AutomaticMemoryDefect => reason !== null);
  if (reasons.length === 0) return null;
  const certain = reasons.length === texts.length && reasons.every(isCertainReason) && fromAutomaticParents(entry, rows);
  return { reason: `derived constituents: ${[...new Set(reasons)].join('; ')}`, disposition: certain ? 'set-aside' : 'review' };
}

function planRows(db: DatabaseSyncLike, tenantId: string) {
  const all = selectAllEntries(db, tenantId);
  const rows = new Map(listDormantSnapshots(db, tenantId).map((snapshot) => [snapshot.entry.id, snapshot.entry]));
  for (const entry of all) rows.set(entry.id, entry);
  const entries = all.filter((entry) => !entry.superseded_by && entry.kind !== 'archived');
  const backing = memoriesBackingObjectsOn(db);
  const issues: QualityRepairIssue[] = [];
  for (const entry of entries) {
    const issue = contentIssue(entry, rows);
    if (issue === null) continue;
    const kept = protection(entry, backing);
    issues.push(kept === undefined ? { id: entry.id, ...issue } : { id: entry.id, ...issue, disposition: 'protected', protection: kept });
  }
  return { total: entries.length, issues };
}

function unsupportedPreview(db: DatabaseSyncLike, tenantId: string) {
  const columns = tableColumns(db, 'memories');
  if (!columns.has('id') || !columns.has('content')) return { total: 0, issues: [] };
  const rows = selectPreviewRows(db, columns, tenantId);
  const issues = rows.flatMap((row): QualityRepairIssue[] => {
    const provenance = { ...row, source: row.source ?? '', confidence: row.confidence ?? 'observed', dag_level: row.dag_level ?? 0, tags: parseJsonArray(row.tags_json) };
    if (!isAutomaticEntry(provenance)) return [];
    const { reason } = assessAutomaticMemory(row.content);
    return reason === null ? [] : [{ id: row.id, reason, disposition: 'review', protection: 'unsupported schema; no changes permitted' }];
  });
  return { total: rows.length, issues };
}

function initialResult(db: DatabaseSyncLike, root: string, tenantId: string): QualityRepairResult {
  const blockers = capabilityBlockers(db);
  const schema = pragmaUserVersion(db);
  const plan = blockers.length > 0 ? unsupportedPreview(db, tenantId) : planRows(db, tenantId);
  return {
    root, schema, supported: blockers.length === 0, blockers,
    total: plan.total,
    issues: plan.issues, appliedIds: [], backup: null, warnings: [],
  };
}

// No rejection record, as in project repair: the writers refuse these defects themselves, and a record would also refuse a person's copy.
function setAsideIssue(db: DatabaseSyncLike, entry: MemoryEntry, reason: string, now: Date, backup: string): boolean {
  const actor = 'quality-repair';
  if (deleteEntryCore(db, entry.id, { actor, automatic: true, suppressForgetAudit: true }) === null) return false;
  insertDormantRow(db, { entry, strength: calculateStrength(entry, now), reason: 'quality-repair', dormantAt: now.toISOString() });
  if (getMeta(db, 'fts5_available', '0') === '1' && ftsRowExists(db, entry.id)) {
    throw new Error(`Quality repair could not remove the full-text row for ${entry.id}`);
  }
  appendAuditEvent(db, { tenantId: entry.tenantId, actor, op: 'quality_repair', targetId: entry.id, metadata: { reason, backup } });
  return true;
}

function applyPlan(db: DatabaseSyncLike, root: string, tenantId: string, backup: string, doneKey?: string): QualityRepairResult {
  return withWriteScope(db, 'quality_repair_apply', () => {
    const result = initialResult(db, root, tenantId);
    if (!result.supported) throw new Error(`Quality repair capability changed: ${result.blockers.join('; ')}`);
    const entries = new Map(selectAllEntries(db, tenantId).map((entry) => [entry.id, entry]));
    const appliedIds: string[] = [];
    const warnings: string[] = [];
    const now = new Date();
    for (const issue of result.issues) {
      if (issue.disposition !== 'set-aside') continue;
      if (setAsideIssue(db, entries.get(issue.id)!, issue.reason, now, backup)) appliedIds.push(issue.id);
      else warnings.push(`Kept ${issue.id}: the store's delete guard protects it.`);
    }
    if (doneKey) setMeta(db, doneKey, '1');
    return { ...result, appliedIds, backup, warnings };
  });
}

function repairOn(db: DatabaseSyncLike, root: string, opts: { tenantId: string; apply?: boolean; doneKey?: string }): QualityRepairResult {
  const initial = withTrialScope(db, 'quality_repair_plan', () => initialResult(db, root, opts.tenantId));
  if (!opts.apply || !initial.supported || !initial.issues.some((issue) => issue.disposition === 'set-aside')) return initial;
  db.exec('PRAGMA foreign_keys = ON');
  const result = withBackup(db, root, 'before-quality-repair', (backup) => applyPlan(db, root, opts.tenantId, backup, opts.doneKey));
  const warnings = [...result.warnings];
  for (const id of result.appliedIds) {
    if (!purgeMirrorBestEffort(root, id, false, 'quality repair')) warnings.push(`Mirror cleanup failed for ${id}; remove its stale mirror before rebuilding the index.`);
  }
  return { ...result, warnings };
}

function openForRepair<T>(root: string, readOnly: boolean, fn: (db: DatabaseSyncLike) => T): T {
  // Opens without openHippoDb to skip migrations, so it takes the same refusal itself.
  assertSqliteAllowed(root);
  const file = path.join(root, 'hippo.db');
  if (!fs.existsSync(file)) throw new Error(`No existing Hippo database at ${file}`);
  const db = new DatabaseSync(file, { readOnly });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    return fn(db);
  } finally {
    db.close();
  }
}

/** Preview by default; apply backs the database up, then moves certain defects to dormant storage, without running migrations. */
export function repairAutomaticMemories(root: string, opts: { tenantId: string; apply?: boolean }): QualityRepairResult {
  return openForRepair(root, !opts.apply, (db) => repairOn(db, root, opts));
}

const AUTO_REPAIR_META_KEY = 'quality_repair_auto';

/** Applies the repair once per store, so stores that predate the quality gate are cleaned on upgrade with no command; null once done. */
export function repairQualityOnce(root: string, tenantId: string): QualityRepairResult | null {
  return openForRepair(root, false, (db) => {
    if (getMeta(db, AUTO_REPAIR_META_KEY) === '1') return null;
    // The apply commits the flag with the moves, so a lock taken between them cannot hide what moved.
    const result = repairOn(db, root, { tenantId, apply: true, doneKey: AUTO_REPAIR_META_KEY });
    // An unsupported schema changed nothing, so the next run tries again once a migration has run.
    if (result.supported && result.backup === null) setMeta(db, AUTO_REPAIR_META_KEY, '1');
    return result;
  });
}
