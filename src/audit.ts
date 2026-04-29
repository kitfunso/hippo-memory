import type { MemoryEntry } from './memory.js';
import type { DatabaseSyncLike } from './db.js';

export type AuditSeverity = 'warning' | 'error';

export interface AuditIssue {
  memoryId: string;
  content: string;
  severity: AuditSeverity;
  reason: string;
}

export interface AuditResult {
  total: number;
  issues: AuditIssue[];
  clean: number;
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'was', 'are', 'were', 'be', 'been', 'being',
  'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'it',
  'this', 'that', 'and', 'or', 'but', 'not', 'no', 'so', 'if', 'do',
  'did', 'does', 'has', 'had', 'have', 'will', 'would', 'could', 'should',
  'may', 'might', 'can', 'shall', 'we', 'i', 'you', 'they', 'he', 'she',
  'my', 'our', 'your', 'its', 'his', 'her', 'their', 'up', 'out', 'just',
  'also', 'then', 'than', 'some', 'all', 'any', 'each', 'very', 'too',
]);

const VAGUE_ONLY = /^[\w\s,.'"-]+$/;

function substantiveWordCount(text: string): number {
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w))
    .length;
}

function isVersionBump(text: string): boolean {
  const t = text.trim();
  // release/bump/prep/tag + version
  if (/^(?:bump|release|prep|tag)\s+(?:to\s+)?v?\d+\.\d+/i.test(t)) return true;
  // bare semver ("0.24.1", "v1.2.3")
  if (/^v?\d+\.\d+\.\d+\s*$/i.test(t)) return true;
  // chore: release 1.2.3 / chore(ci): bump v1.2.3
  if (/^chore(?:\([^)]+\))?:\s*(?:release|bump|version|tag|prep)\b/i.test(t)) return true;
  // Merge commits
  if (/^(?:Merge branch|Merge pull request)\b/i.test(t)) return true;
  // WIP sentinels
  if (/^WIP\b/i.test(t)) return true;
  return false;
}

function isFragment(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.startsWith('to ') && trimmed.length < 50) return true;
  if (trimmed.startsWith('for ') && trimmed.length < 50) return true;
  if (trimmed.startsWith('and ') && trimmed.length < 50) return true;
  return false;
}

function hasNoSpecificity(text: string): boolean {
  const words = text.toLowerCase().split(/\s+/);
  const hasNumber = /\d/.test(text);
  const hasProperNoun = /[A-Z][a-z]{2,}/.test(text);
  const hasPath = /[/\\.]/.test(text);
  const hasCode = /[`_{}()\[\]]/.test(text);
  if (hasNumber || hasProperNoun || hasPath || hasCode) return false;
  return words.length < 8 && VAGUE_ONLY.test(text);
}

export function auditMemory(entry: MemoryEntry): AuditIssue | null {
  const content = entry.content.trim();

  if (content.length < 3) {
    return { memoryId: entry.id, content, severity: 'error', reason: 'too short (< 3 chars)' };
  }

  if (content.length < 10) {
    return { memoryId: entry.id, content, severity: 'error', reason: 'too short (< 10 chars)' };
  }

  if (isVersionBump(content)) {
    return { memoryId: entry.id, content, severity: 'error', reason: 'release/commit noise, not a useful memory' };
  }

  if (isFragment(content)) {
    return { memoryId: entry.id, content, severity: 'warning', reason: 'sentence fragment — lacks context' };
  }

  const substantive = substantiveWordCount(content);
  if (substantive < 2) {
    return { memoryId: entry.id, content, severity: 'warning', reason: `only ${substantive} substantive word(s) — too vague` };
  }

  if (content.length < 40 && hasNoSpecificity(content)) {
    return { memoryId: entry.id, content, severity: 'warning', reason: 'no specific details (names, paths, numbers, code)' };
  }

  return null;
}

export function auditMemories(entries: MemoryEntry[]): AuditResult {
  const issues: AuditIssue[] = [];
  for (const entry of entries) {
    const issue = auditMemory(entry);
    if (issue) issues.push(issue);
  }
  return {
    total: entries.length,
    issues,
    clean: entries.length - issues.length,
  };
}

export function isContentWorthStoring(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length < 10) return false;
  if (isVersionBump(trimmed)) return false;
  if (isFragment(trimmed)) return false;
  if (substantiveWordCount(trimmed) < 2) return false;
  if (trimmed.length < 40 && hasNoSpecificity(trimmed)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// A5 audit log primitives (append-only mutation trail)
// ---------------------------------------------------------------------------

export type AuditOp =
  | 'remember'
  | 'recall'
  | 'promote'
  | 'supersede'
  | 'forget'
  | 'archive_raw';

export interface AppendAuditOpts {
  tenantId: string;
  actor: string; // 'cli' | 'api_key:hk_...' | 'system'
  op: AuditOp;
  targetId?: string;
  metadata?: Record<string, unknown>;
}

export function appendAuditEvent(db: DatabaseSyncLike, opts: AppendAuditOpts): void {
  db.prepare(
    `INSERT INTO audit_log (ts, tenant_id, actor, op, target_id, metadata_json) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    new Date().toISOString(),
    opts.tenantId,
    opts.actor,
    opts.op,
    opts.targetId ?? null,
    JSON.stringify(opts.metadata ?? {}),
  );
}

export interface QueryAuditOpts {
  tenantId: string;
  op?: AuditOp;
  since?: string; // ISO timestamp
  limit?: number;
}

export interface AuditEvent {
  id: number;
  ts: string;
  tenantId: string;
  actor: string;
  op: AuditOp;
  targetId: string | null;
  metadata: Record<string, unknown>;
}

export function queryAuditEvents(db: DatabaseSyncLike, opts: QueryAuditOpts): AuditEvent[] {
  const where: string[] = ['tenant_id = ?'];
  const params: unknown[] = [opts.tenantId];
  if (opts.op) {
    where.push('op = ?');
    params.push(opts.op);
  }
  if (opts.since) {
    where.push('ts >= ?');
    params.push(opts.since);
  }
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 10000));
  const rows = db
    .prepare(
      `SELECT id, ts, tenant_id, actor, op, target_id, metadata_json
       FROM audit_log WHERE ${where.join(' AND ')} ORDER BY ts DESC, id DESC LIMIT ?`,
    )
    .all(...params, limit) as Array<{
    id: number;
    ts: string;
    tenant_id: string;
    actor: string;
    op: string;
    target_id: string | null;
    metadata_json: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    tenantId: r.tenant_id,
    actor: r.actor,
    op: r.op as AuditOp,
    targetId: r.target_id,
    metadata: safeJsonParse(r.metadata_json),
  }));
}

function safeJsonParse(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
