import fs from 'node:fs';
import path from 'node:path';
import { assessAutomaticMemory } from './automatic-memory-quality.js';
import { appendAuditEvent } from './audit.js';
import { DatabaseSync, type DatabaseSyncLike } from './db/sqlite.js';
import { getMeta } from './db/meta.js';
import { assertBinaryCompatible } from './db/migrate.js';
import { insertDormantRow } from './dormant.js';
import { calculateStrength, isKeptForGood, type MemoryEntry } from './memory.js';
import { backupStore } from './project-merge.js';
import { insertRejectedValue, normalizeValueForRejection, rejectionDigest } from './rejection.js';
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

const REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  memories: MEMORY_SELECT_COLUMNS.split(',').map((s) => s.trim()),
  meta: ['key', 'value'],
  dormant_memories: ['tenant_id', 'id', 'content', 'entry_json', 'reason', 'strength', 'dormant_at'],
  rejected_values: ['tenant_id', 'digest', 'reason', 'rejected_by', 'rejected_at', 'source_memory_id', 'normalized_chars'],
  audit_log: ['ts', 'tenant_id', 'actor', 'op', 'target_id', 'metadata_json'],
  ...Object.fromEntries(MEMORY_BACKED_TABLES.map((table) => [table, ['memory_id']])),
};
const REVIEW_REASONS = new Set(['too-short', 'too-vague', 'no-specificity']);

function capabilityBlockers(db: DatabaseSyncLike): string[] {
  const blockers: string[] = [];
  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => (row as { name: string }).name));
    if (columns.size === 0) blockers.push(`missing table: ${table}`);
    else for (const column of required) if (!columns.has(column)) blockers.push(`missing column: ${table}.${column}`);
  }
  if (blockers.some((blocker) => blocker === 'missing table: meta' || blocker.startsWith('missing column: meta.'))) return blockers;
  assertBinaryCompatible(db);
  if (getMeta(db, 'fts5_available', '0') === '1') {
    const columns = new Set(db.prepare('PRAGMA table_info(memories_fts)').all().map((row) => (row as { name: string }).name));
    for (const column of ['id', 'content', 'tags']) {
      if (!columns.has(column)) blockers.push(`missing column: memories_fts.${column}`);
    }
  }
  return blockers;
}

function backingIds(db: DatabaseSyncLike): Set<string> {
  const ids = new Set<string>();
  for (const table of MEMORY_BACKED_TABLES) {
    for (const row of db.prepare(`SELECT memory_id FROM ${table} WHERE memory_id IS NOT NULL`).all()) {
      ids.add((row as { memory_id: string }).memory_id);
    }
  }
  return ids;
}

function protection(entry: MemoryEntry, backing: ReadonlySet<string>): string | undefined {
  if (entry.pinned) return 'pinned';
  if (entry.kind === 'raw') return 'raw receipt';
  if (isKeptForGood(entry)) return 'trusted imported note';
  if (backing.has(entry.id)) return 'backs an object';
  return undefined;
}

function structured(entry: MemoryEntry): boolean {
  return entry.trace_outcome !== null || entry.tags.includes('session-digest') || entry.source === 'auto-promote';
}

function contentIssue(entry: MemoryEntry): Omit<QualityRepairIssue, 'id'> | null {
  if (structured(entry)) return null;
  const bundle = /^\[Consolidated(?: from| pattern from) \d+ related memor(?:y|ies)(?:, newest first)?\]\n\n/.test(entry.content);
  const texts = heldTexts(bundle ? { ...entry, source: 'consolidation' } : entry);
  if (texts.length > 0) {
    const bad = texts.map(assessAutomaticMemory).filter((assessment) => !assessment.accepted);
    if (bad.length === 0) return null;
    const reason = [...new Set(bad.map((assessment) => assessment.reason ?? 'automatic quality defect'))].join('; ');
    const certain = bad.every((assessment) => assessment.reason !== null && !REVIEW_REASONS.has(assessment.reason));
    return { reason: `derived constituents: ${reason}`, disposition: bad.length === texts.length && certain ? 'quarantine' : 'review' };
  }
  if (bundle) return { reason: 'derived bundle has no safely parsed constituents', disposition: 'review' };
  const assessment = assessAutomaticMemory(entry.content);
  return assessment.accepted ? null : {
    reason: assessment.reason ?? 'automatic quality defect',
    disposition: assessment.reason !== null && REVIEW_REASONS.has(assessment.reason) ? 'review' : 'quarantine',
  };
}

function planRows(db: DatabaseSyncLike, tenantId: string): { entries: MemoryEntry[]; issues: QualityRepairIssue[] } {
  const entries = selectAllEntries(db, tenantId).filter((entry) => !entry.superseded_by && entry.kind !== 'archived');
  const backing = backingIds(db);
  const issues: QualityRepairIssue[] = [];
  for (const entry of entries) {
    const issue = contentIssue(entry);
    if (issue === null) continue;
    const kept = protection(entry, backing);
    issues.push({ id: entry.id, ...issue, ...(kept ? { disposition: 'protected', protection: kept } as const : {}) });
  }
  return { entries, issues };
}

function unsupportedPreview(db: DatabaseSyncLike, tenantId: string): { total: number; issues: QualityRepairIssue[] } {
  const columns = new Set(db.prepare('PRAGMA table_info(memories)').all().map((row) => (row as { name: string }).name));
  if (!columns.has('id') || !columns.has('content')) return { total: 0, issues: [] };
  const tenant = columns.has('tenant_id') ? ' WHERE tenant_id = ?' : '';
  const statement = db.prepare(`SELECT id, content FROM memories${tenant}`);
  const rows = (tenant ? statement.all(tenantId) : statement.all()) as { id: string; content: string }[];
  const issues = rows.flatMap((row): QualityRepairIssue[] => {
    const assessment = assessAutomaticMemory(row.content);
    return assessment.accepted ? [] : [{ id: row.id, reason: assessment.reason ?? 'automatic quality defect', disposition: 'review', protection: 'unsupported schema; no changes permitted' }];
  });
  return { total: rows.length, issues };
}

function initialResult(db: DatabaseSyncLike, root: string, tenantId: string): QualityRepairResult {
  const blockers = capabilityBlockers(db);
  const schema = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  const plan = blockers.length > 0 ? unsupportedPreview(db, tenantId) : planRows(db, tenantId);
  return {
    root, schema, supported: blockers.length === 0, blockers,
    total: 'entries' in plan ? plan.entries.length : plan.total,
    issues: plan.issues, appliedIds: [], backup: null, warnings: [],
  };
}

function archiveIssue(db: DatabaseSyncLike, entry: MemoryEntry, reason: string, now: Date): boolean {
  const actor = 'quality-repair';
  const digest = rejectionDigest(entry.content);
  insertDormantRow(db, { entry, strength: calculateStrength(entry, now), reason: 'quality-repair', dormantAt: now.toISOString() });
  insertRejectedValue(db, {
    tenantId: entry.tenantId, digest, reason, rejectedBy: actor, rejectedAt: now.toISOString(),
    sourceMemoryId: entry.id, normalizedChars: normalizeValueForRejection(entry.content).length,
  });
  const removed = deleteEntryCore(db, entry.id, { actor, automatic: true, suppressForgetAudit: true });
  if (!removed) throw new Error(`Quality repair refused ${entry.id}; its protection changed.`);
  if (getMeta(db, 'fts5_available', '0') === '1' && db.prepare('SELECT id FROM memories_fts WHERE id = ?').get(entry.id)) {
    throw new Error(`Quality repair could not remove the full-text row for ${entry.id}`);
  }
  appendAuditEvent(db, {
    tenantId: entry.tenantId, actor, op: 'reject_value', targetId: entry.id,
    metadata: { digest, reason, removedIds: [entry.id], count: 1, preservedDormant: true },
  });
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
      if (issue.disposition === 'quarantine' && archiveIssue(db, entries.get(issue.id)!, issue.reason, now)) appliedIds.push(issue.id);
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
