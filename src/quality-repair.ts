import fs from 'node:fs';
import path from 'node:path';
import {
  assessAutomaticMemory, BUNDLE_HEADER, isAutomaticEntry, UNCERTAIN_REASONS, type AutomaticMemoryAssessment,
} from './automatic-memory-quality.js';
import { appendAuditEvent } from './audit.js';
import { DatabaseSync, type DatabaseSyncLike } from './db/sqlite.js';
import { getMeta } from './db/meta.js';
import { tableColumns } from './db/tables.js';
import { assertBinaryCompatible } from './db/migrate.js';
import { insertDormantRow } from './dormant.js';
import { calculateStrength, isKeptForGood, type MemoryEntry } from './memory.js';
import { backupStore } from './project-merge.js';
import { heldTexts } from './same-text.js';
import { deleteEntryCore, MEMORY_BACKED_TABLES } from './store/delete-and-batch.js';
import { selectAllEntries } from './store/entry-reads.js';
import { MEMORY_SELECT_COLUMNS } from './store/rows.js';
import { purgeMirrorBestEffort } from './store/mirrors.js';

export interface QualityRepairIssue {
  readonly id: string;
  readonly reason: string;
  readonly disposition: 'quarantine' | 'review' | 'protected';
  readonly protection?: string;
}

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

function backingIds(db: DatabaseSyncLike): Set<string> {
  const ids = new Set<string>();
  for (const table of MEMORY_BACKED_TABLES) {
    // SAFETY: the SELECT names one memory_id column and filters out NULLs.
    const rows = db.prepare(`SELECT memory_id FROM ${table} WHERE memory_id IS NOT NULL`).all() as { memory_id: string }[];
    for (const row of rows) ids.add(row.memory_id);
  }
  return ids;
}

/** Rows a person brought back from dormant storage: hiding them again would undo that decision. */
function restoredIds(db: DatabaseSyncLike, tenantId: string): Set<string> {
  // SAFETY: the SELECT names one target_id column and filters out NULLs.
  const rows = db.prepare("SELECT target_id FROM audit_log WHERE tenant_id = ? AND op = 'dormant_restore' AND target_id IS NOT NULL").all(tenantId) as { target_id: string }[];
  return new Set(rows.map((row) => row.target_id));
}

function protection(entry: MemoryEntry, backing: ReadonlySet<string>, restored: ReadonlySet<string>): string | undefined {
  if (entry.pinned) return 'pinned';
  if (entry.kind === 'raw') return 'raw receipt';
  if (isKeptForGood(entry)) return 'trusted imported note';
  if (backing.has(entry.id)) return 'backs an object';
  if (restored.has(entry.id)) return 'restored by hand';
  return undefined;
}

function structured(entry: MemoryEntry): boolean {
  return entry.trace_outcome !== null || entry.tags.includes('session-digest') || entry.source === 'auto-promote';
}

function isCertain(assessment: AutomaticMemoryAssessment): boolean {
  return assessment.reason !== null && !UNCERTAIN_REASONS.has(assessment.reason);
}

function contentIssue(entry: MemoryEntry): Omit<QualityRepairIssue, 'id'> | null {
  if (structured(entry) || !isAutomaticEntry(entry)) return null;
  const bundle = BUNDLE_HEADER.test(entry.content);
  // Only a bundle header marks parts; a refined row keeps its lead line, so it is judged whole.
  const texts = bundle ? heldTexts({ ...entry, source: 'consolidation' }) : [];
  if (texts.length > 0) {
    const bad = texts.map(assessAutomaticMemory).filter((assessment) => !assessment.accepted);
    if (bad.length === 0) return null;
    const reason = [...new Set(bad.map((assessment) => assessment.reason ?? 'automatic quality defect'))].join('; ');
    return { reason: `derived constituents: ${reason}`, disposition: bad.length === texts.length && bad.every(isCertain) ? 'quarantine' : 'review' };
  }
  if (bundle) return { reason: 'derived bundle has no safely parsed constituents', disposition: 'review' };
  const assessment = assessAutomaticMemory(entry.content);
  return assessment.accepted ? null : {
    reason: assessment.reason ?? 'automatic quality defect',
    disposition: isCertain(assessment) ? 'quarantine' : 'review',
  };
}

function planRows(db: DatabaseSyncLike, tenantId: string) {
  const entries = selectAllEntries(db, tenantId).filter((entry) => !entry.superseded_by && entry.kind !== 'archived');
  const backing = backingIds(db);
  const restored = restoredIds(db, tenantId);
  const issues: QualityRepairIssue[] = [];
  for (const entry of entries) {
    const issue = contentIssue(entry);
    if (issue === null) continue;
    const kept = protection(entry, backing, restored);
    issues.push(kept === undefined ? { id: entry.id, ...issue } : { id: entry.id, ...issue, disposition: 'protected', protection: kept });
  }
  return { total: entries.length, issues };
}

function unsupportedPreview(db: DatabaseSyncLike, tenantId: string) {
  const columns = tableColumns(db, 'memories');
  if (!columns.has('id') || !columns.has('content')) return { total: 0, issues: [] };
  const tenant = columns.has('tenant_id') ? ' WHERE tenant_id = ?' : '';
  const column = (name: string, fallback: string): string => (columns.has(name) ? name : `${fallback} AS ${name}`);
  const statement = db.prepare(`SELECT id, content, ${column('source', "''")}, ${column('confidence', 'NULL')}, ${column('extracted_from', 'NULL')}, ${column('dag_level', '0')} FROM memories${tenant}`);
  // SAFETY: the SELECT names every Row field, each a literal fallback when its column is missing.
  const rows = (tenant ? statement.all(tenantId) : statement.all()) as Array<{
    id: string; content: string; source: string | null; confidence: MemoryEntry['confidence'] | null; extracted_from: string | null; dag_level: number | null;
  }>;
  const issues = rows.flatMap((row): QualityRepairIssue[] => {
    const provenance = { ...row, source: row.source ?? '', confidence: row.confidence ?? 'observed', dag_level: row.dag_level ?? 0 };
    if (!isAutomaticEntry(provenance)) return [];
    const assessment = assessAutomaticMemory(row.content);
    return assessment.accepted ? [] : [{ id: row.id, reason: assessment.reason ?? 'automatic quality defect', disposition: 'review', protection: 'unsupported schema; no changes permitted' }];
  });
  return { total: rows.length, issues };
}

function initialResult(db: DatabaseSyncLike, root: string, tenantId: string): QualityRepairResult {
  const blockers = capabilityBlockers(db);
  // SAFETY: PRAGMA user_version returns one row with one integer column.
  const schema = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  const plan = blockers.length > 0 ? unsupportedPreview(db, tenantId) : planRows(db, tenantId);
  return {
    root, schema, supported: blockers.length === 0, blockers,
    total: plan.total,
    issues: plan.issues, appliedIds: [], backup: null, warnings: [],
  };
}

// No rejection record, as in project repair: the writers refuse these defects themselves, and a record would also refuse a person's copy.
function archiveIssue(db: DatabaseSyncLike, entry: MemoryEntry, reason: string, now: Date, backup: string): boolean {
  const actor = 'quality-repair';
  insertDormantRow(db, { entry, strength: calculateStrength(entry, now), reason: 'quality-repair', dormantAt: now.toISOString() });
  const removed = deleteEntryCore(db, entry.id, { actor, automatic: true, suppressForgetAudit: true });
  if (!removed) throw new Error(`Quality repair refused ${entry.id}; its protection changed.`);
  if (getMeta(db, 'fts5_available', '0') === '1' && db.prepare('SELECT id FROM memories_fts WHERE id = ?').get(entry.id)) {
    throw new Error(`Quality repair could not remove the full-text row for ${entry.id}`);
  }
  appendAuditEvent(db, { tenantId: entry.tenantId, actor, op: 'quality_repair', targetId: entry.id, metadata: { reason, backup } });
  return true;
}

function applyPlan(db: DatabaseSyncLike, root: string, tenantId: string, backup: string): QualityRepairResult {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = initialResult(db, root, tenantId);
    if (!result.supported) throw new Error(`Quality repair capability changed: ${result.blockers.join('; ')}`);
    const entries = new Map(selectAllEntries(db, tenantId).map((entry) => [entry.id, entry]));
    const appliedIds: string[] = [];
    const now = new Date();
    for (const issue of result.issues) {
      if (issue.disposition === 'quarantine' && archiveIssue(db, entries.get(issue.id)!, issue.reason, now, backup)) appliedIds.push(issue.id);
    }
    db.exec('COMMIT');
    return { ...result, appliedIds, backup };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve the mutation error */ }
    throw error;
  }
}

/** Preview by default; apply preserves rejected values in dormant snapshots and a database backup, without running migrations. */
export function repairAutomaticMemories(root: string, opts: { tenantId: string; apply?: boolean }): QualityRepairResult {
  const file = path.join(root, 'hippo.db');
  if (!fs.existsSync(file)) throw new Error(`No existing Hippo database at ${file}`);
  const db = new DatabaseSync(file, { readOnly: !opts.apply });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('BEGIN');
    const initial = initialResult(db, root, opts.tenantId);
    db.exec('ROLLBACK');
    if (!opts.apply || !initial.supported || !initial.issues.some((issue) => issue.disposition === 'quarantine')) return initial;
    const backup = backupStore(db, root, 'before-quality-repair');
    db.exec('PRAGMA foreign_keys = ON');
    const result = applyPlan(db, root, opts.tenantId, backup);
    const warnings: string[] = [];
    for (const id of result.appliedIds) {
      if (!purgeMirrorBestEffort(root, id, false, 'quality repair')) warnings.push(`Mirror cleanup failed for ${id}; remove its stale mirror before rebuilding the index.`);
    }
    return { ...result, warnings };
  } finally {
    db.close();
  }
}
