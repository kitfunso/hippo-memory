import { createHash } from 'node:crypto';
import { canAutoDelete, type MemoryEntry } from './memory.js';
import type { DatabaseSyncLike } from './db.js';
import type { JsonObject, JsonValue } from './working-memory.js';
import { log } from './log.js';

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

export const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'was', 'are', 'were', 'be', 'been', 'being',
  'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'it',
  'this', 'that', 'and', 'or', 'but', 'not', 'no', 'so', 'if', 'do',
  'did', 'does', 'has', 'had', 'have', 'will', 'would', 'could', 'should',
  'may', 'might', 'can', 'shall', 'we', 'i', 'you', 'they', 'he', 'she',
  'my', 'our', 'your', 'its', 'his', 'her', 'their', 'up', 'out', 'just',
  'also', 'then', 'than', 'some', 'all', 'any', 'each', 'very', 'too',
]);

const VAGUE_ONLY = /^[\w\s,.'"-]+$/;

// Han, Hiragana and Katakana carry no whitespace word boundaries, so a plain
// \s+ split scores
// an entire sentence as one "word" and the gate rejects real sentences as junk.
// CJK words average ~2 characters, so approximate substantive units as one per
// 2 CJK LETTERS.
//
// Two properties this must hold, both learned from codex review findings:
//  1. Letters only, enforced by construction. Two separate wrong guesses were
//     caught here: a Katakana BLOCK range counts the middle dot and prolonged
//     sound mark, and `\p{Script=Han}` alone still counts Han-script
//     NON-letters (Kangxi radicals, the old Chinese hook mark) because Script
//     properties are not restricted to letters. The `(?=\p{L})` lookahead
//     makes "letters only" true by definition rather than by assertion, and
//     the category sweep in tests/df3-cjk-quality-floor.test.ts pins it so the
//     next wrong guess fails locally instead of in review.
//
// SCOPE, stated precisely because the constant name says "CJK": this covers
// Han, Hiragana and Katakana only. Hangul is absent (Korean largely survives
// the whitespace split already) and other spaceless scripts - Thai, Khmer,
// Burmese, Lao - still hit the original one-word failure. Their behavior is
// byte-identical to before this change, so nothing regressed; widening the
// script set is a separate, deliberately-scoped follow-up rather than another
// mid-episode guess at this predicate.
//  2. ADD to the latin count, never strip before it. Stripping CJK first can
//     REDUCE the count for short mixed tokens (`UI<han> DB<han> QA<han>` leaves
//     three 2-char latin fragments that fail the `> 2` filter), which would
//     reject content this gate previously accepted and make capture silently
//     drop it. Adding keeps the change strictly more permissive - the property
//     that makes it safe in a predicate shared with capture's write gate.
const CJK_LETTERS = /(?=\p{L})(?:\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana})/gu;

function substantiveWordCount(text: string): number {
  const cjkLetterCount = (text.match(CJK_LETTERS) ?? []).length;
  const latinWordCount = text
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w))
    .length;
  return latinWordCount + Math.floor(cjkLetterCount / 2);
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
  // An ACRONYM is specificity too, and this test could not see one: the
  // proper-noun pattern needs lowercase after the capital, so "PR", "CI",
  // "DB", "API", "S3" - the densest domain tokens in a technical memory -
  // all read as vague. Surfaced by DF2: clause-bounding correctly shortened
  // "The rule is every PR needs two approvals, no exceptions." to "every PR
  // needs two approvals", which then fell under the 40-char vagueness gate
  // and was silently DROPPED - a rule that stored before this branch.
  // ...but an acronym only signals specificity when it stands out AGAINST
  // ordinary prose. Without the lowercase requirement, any shouted phrase
  // qualifies: "FIXED SIGNALS" passed the gate while the identical
  // "fixed signals" was correctly rejected, so capitalization alone bought a
  // bypass - into auditMemory and includeRecent as well, where junk would
  // then occupy recent-context slots. Codex P2, r8.
  // CHAT acronyms are not domain signal. Admitting any all-caps token let
  // "LGTM ship it", "TODO fix this thing", "FYI all done here" through a gate
  // that correctly rejected them before - and this gate is shared, so the
  // effect is retroactive: junk rows already in a user's store were filtered
  // out of recent-context slots and would have started occupying them, and
  // `hippo audit` would have stopped flagging them. Found at the ship gate.
  const CHAT_ACRONYMS = /^(?:TODO|FYI|LGTM|IIRC|IMO|IMHO|FWIW|TBD|BTW|ASAP|AFAIK|WIP|NB|PS)$/;
  const domainAcronyms = (text.match(/\b[A-Z]{2,6}\b/g) ?? []).filter(a => !CHAT_ACRONYMS.test(a));
  const hasAcronym = domainAcronyms.length > 0 && /[a-z]/.test(text);
  const hasPath = /[/\\.]/.test(text);
  const hasCode = /[`_{}()\[\]]/.test(text);
  if (hasNumber || hasProperNoun || hasPath || hasCode || hasAcronym) return false;
  return words.length < 8 && VAGUE_ONLY.test(text);
}

export function auditMemory(entry: MemoryEntry, backsObject = false): AuditIssue | null {
  const issue = classifyMemory(entry);
  // Error means "auto-remove"; a pinned, raw, kept-for-good or object-backing row is never auto-removed, so it can only warn.
  if (issue?.severity === 'error' && (!canAutoDelete(entry) || backsObject)) {
    const why = entry.pinned ? 'pinned' : entry.kind === 'raw' ? 'raw' : backsObject ? 'backs an object' : 'keep rule';
    return { ...issue, severity: 'warning', reason: `${issue.reason} (${why}, kept)` };
  }
  return issue;
}

function classifyMemory(entry: MemoryEntry): AuditIssue | null {
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

/** `backing`: ids of memories that back an object (store.memoriesBackingObjects). */
export function auditMemories(entries: MemoryEntry[], backing: ReadonlySet<string>): AuditResult {
  const issues: AuditIssue[] = [];
  for (const entry of entries) {
    const issue = auditMemory(entry, backing.has(entry.id));
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

// The one list of audit ops: the AuditOp type, `hippo audit list --op` and GET /v1/audit?op= all read it.
export const AUDIT_OPS = [
  'remember',
  'recall',
  'promote',
  'supersede',
  'forget',
  'archive_raw',
  'auth_revoke',
  'auth_create', // emitted by api.authCreate
  'outcome',
  'consolidate', // emitted once per api.sleep invocation
  'audit_prune', // emitted by pruneAuditLog after each retention prune
  'summary_marked_dirty', // emitted by markSummaryDirty on the 0->1 transition
  'summary_marked_clean', // emitted by clearSummaryDirtyAfterBuild after the buildDag child-link loop
  'summary_rebuilt', // emitted by applyRebuildResult on a successful sleep-cycle rebuild
  'predict_create', // emitted by savePrediction
  'predict_close', // emitted by closePrediction
  'predict_baserate', // emitted by computePredictionBaserate
  'recall_autodebias_hint', // emitted by computePlanningFallacyOutput on success
  'recall_autodebias_hint_no_class_match', // telemetry: forward-claim detected, no class scored
  'recall_autodebias_hint_tiebreak', // telemetry: forward-claim detected, two or more classes tied
  'recall_anchor_detected_query_repeat', // emitted by the anchoring detector when the same query returns the same top-1
  'recall_anchor_detected_memory_dominance', // emitted by the anchoring detector when one memory wins top-1 across distinct queries
  'recall_anchor_skipped_no_session', // telemetry: no sessionId, so ring tracking was skipped
  'recall_availability_detected', // emitted when the availability/recency-bias hint fires
  'decision_create', // emitted by saveDecision
  'decision_supersede', // emitted by saveDecision when --supersedes resolves to an active decision
  'decision_close', // emitted by closeDecision
  'incident_open', // emitted by saveIncident
  'incident_resolve', // emitted by resolveIncident
  'incident_close', // emitted by closeIncident
  'process_create', // emitted by saveProcess
  'process_supersede', // emitted by saveProcess on a supersession
  'process_close', // emitted by closeProcess
  'policy_create', // emitted by savePolicy
  'policy_supersede', // emitted by savePolicy on a supersession
  'policy_close', // emitted by closePolicy
  'skill_create', // emitted by saveSkill
  'skill_supersede', // emitted by saveSkill on a supersession
  'skill_close', // emitted by closeSkill
  'project_brief_create', // emitted by saveProjectBrief
  'project_brief_supersede', // emitted by saveProjectBrief on a supersession, including a refresh
  'project_brief_close', // emitted by closeProjectBrief
  'customer_note_create', // emitted by saveCustomerNote
  'customer_note_supersede', // emitted by saveCustomerNote on a supersession
  'customer_note_close', // emitted by closeCustomerNote
  'mv_rescue', // emitted by consolidate() per rescued entry when config.memoryValue.enabled
  'reject_value', // emitted by the `hippo reject` verb
  'reject_refusal', // emitted when the rejection guard refuses a write
  'unreject_value', // emitted by the `hippo unreject` verb
  'conflict_resolve', // emitted by resolveConflict on every resolution path
  'half_life_migrate', // emitted by migrateDefaultHalfLife with the rescaled ids
  'dormant_restore', // emitted by api.restoreDormant
  'auth_grant', // emitted by api.authGrant
  'auth_ungrant', // emitted by api.authUngrant
  'quarantine', // emitted by recordQuarantine inside remember's write transaction
  'quarantine_approve', // emitted by api.quarantineApprove
  'quarantine_reject', // emitted by api.quarantineReject
  'agent_memory_restore', // emitted by the agent memory sync when a deleted note comes back
  'agent_memory_set_aside', // emitted by the agent memory sync when a note is deleted or refused
  'project_merge', // emitted by `hippo projects merge --apply` with every id it touched
  'project_repair', // emitted by `hippo projects repair --apply` with every id it touched
] as const;

export type AuditOp = (typeof AUDIT_OPS)[number];

export interface AppendAuditOpts {
  tenantId: string;
  actor: string; // 'cli' | 'api_key:hk_...' | 'system'
  op: AuditOp;
  targetId?: string;
  // Callers attach arbitrary contextual data here (out-of-scope src/cli.ts's
  // emitCliAudit still types this Record<string, unknown>); appendAuditEvent
  // never reads a field off it, only JSON.stringify's it wholesale below, so
  // it stays genuinely opaque rather than claiming a parsed contract it can't
  // enforce at every call site.
  metadata?: unknown;
}

// node:sqlite returns INTEGER columns as bigint when the value exceeds
// Number.MAX_SAFE_INTEGER. Audit metadata can carry such values (row ids,
// counts), and JSON.stringify cannot serialize bigint without a replacer.
// Mirrors the bigintSafeReplacer in src/raw-archive.ts.
// `JsonValueWithBigInt` stands in for JSON.stringify's own `(key: string,
// value: any) => any` replacer contract without exposing `any`/`unknown` at
// this function's boundary; it is still assignable where JSON.stringify
// expects a replacer.
type JsonValueWithBigInt = JsonValue | bigint;

function isBigIntValue(value: JsonValueWithBigInt): value is bigint {
  return typeof value === 'bigint';
}

function bigintSafeReplacer(_key: string, value: JsonValueWithBigInt): JsonValueWithBigInt {
  return isBigIntValue(value) ? value.toString() : value;
}

export type AuditQueryFields = {
  query_hash: string;
  query_length: number;
};

export function auditQueryFields(query: string): AuditQueryFields {
  return {
    query_hash: createHash('sha256').update(query).digest('hex').slice(0, 16),
    query_length: query.length,
  };
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
    JSON.stringify(opts.metadata ?? {}, bigintSafeReplacer),
  );
}

let auditWriteFailures = 0;

/** For callers that keep a mutation when its audit row fails: the failure is logged and counted, never silent. */
export function reportAuditWriteFailure(op: AuditOp, reason: string, targetId?: string | null): void {
  auditWriteFailures++;
  log.error(`audit write failed: ${reason}`, { op, target: targetId ?? undefined });
}

/** Audit rows this process failed to write; the loopback `/health` body reports it. */
export function auditWriteFailureCount(): number {
  return auditWriteFailures;
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
  metadata: JsonObject;
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
  // SAFETY: AUDIT_COLUMNS names exactly the AuditRow columns, in this order.
  const rows = db
    .prepare(
      `SELECT ${AUDIT_COLUMNS} FROM audit_log WHERE ${where.join(' AND ')} ORDER BY ts DESC, id DESC LIMIT ?`,
    )
    .all(...params, limit) as AuditRow[];
  return rows.map(rowToAuditEvent);
}

export interface ListAuditAfterOpts {
  /** Last id already consumed; 0 starts from the beginning. */
  afterId: number;
  /** Clamped to 1..10000; default 1000. */
  limit?: number;
  /** Omit for every tenant (deployment-wide export). */
  tenantId?: string;
}

/**
 * Cursor read: events with id > afterId, ascending by id. Ids are AUTOINCREMENT
 * and never reused, but deletes (retention prune) leave gaps, so resume from
 * the last id returned, never from a count.
 */
export function listAuditEventsAfter(db: DatabaseSyncLike, opts: ListAuditAfterOpts): AuditEvent[] {
  if (!Number.isInteger(opts.afterId) || opts.afterId < 0) {
    throw new RangeError('afterId must be a non-negative integer');
  }
  if (opts.limit !== undefined && !Number.isInteger(opts.limit)) {
    throw new RangeError('limit must be an integer');
  }
  const where: string[] = ['id > ?'];
  const params: unknown[] = [opts.afterId];
  if (opts.tenantId !== undefined) {
    where.push('+tenant_id = ?');
    params.push(opts.tenantId);
  }
  const limit = Math.max(1, Math.min(opts.limit ?? 1000, 10000));
  // SAFETY: AUDIT_COLUMNS names exactly the AuditRow columns, in this order.
  const rows = db
    .prepare(`SELECT ${AUDIT_COLUMNS} FROM audit_log WHERE ${where.join(' AND ')} ORDER BY id ASC LIMIT ?`)
    .all(...params, limit) as AuditRow[];
  return rows.map(rowToAuditEvent);
}

const AUDIT_COLUMNS = 'id, ts, tenant_id, actor, op, target_id, metadata_json';

interface AuditRow {
  id: number;
  ts: string;
  tenant_id: string;
  actor: string;
  op: string;
  target_id: string | null;
  metadata_json: string;
}

function rowToAuditEvent(r: AuditRow): AuditEvent {
  return {
    id: r.id,
    ts: r.ts,
    tenantId: r.tenant_id,
    actor: r.actor,
    // SAFETY: audit_log.op is only ever written by appendAuditEvent, whose opts.op is
    // typed AuditOp at the INSERT call site, so every stored value is a valid AuditOp.
    op: r.op as AuditOp,
    targetId: r.target_id,
    metadata: safeJsonParse(r.metadata_json),
  };
}

function safeJsonParse(raw: string): JsonObject {
  try {
    const v = JSON.parse(raw);
    // SAFETY: JSON.parse only ever returns a plain object, array, string, number,
    // boolean, or null; `v instanceof Object` is true for exactly the first two
    // (both are valid JsonObject shapes for our purposes), matching the prior
    // `typeof v === 'object' && v !== null` check without using typeof.
    return v instanceof Object ? (v as JsonObject) : {};
  } catch {
    return {};
  }
}
