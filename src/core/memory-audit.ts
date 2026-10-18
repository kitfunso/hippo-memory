// The memory-quality audit rules: pure functions of a row, so any store can be audited by them.
import { canAutoDelete, isKeptForGood, type MemoryEntry } from './memory.js';
import {
  automaticDefect,
  hasNoSpecificity,
  isFragment,
  isReleaseCommitNoise,
  substantiveWordCount,
} from './memory-quality.js';

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

export function auditMemory(entry: MemoryEntry, backsObject = false): AuditIssue | null {
  const issue = classifyMemory(entry);
  // Error means "auto-remove"; a pinned, raw, kept-for-good or object-backing row is never auto-removed, so it can only
  // warn.
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

  if (isReleaseCommitNoise(content)) {
    return { memoryId: entry.id, content, severity: 'error', reason: 'release/commit noise, not a useful memory' };
  }

  if (isFragment(content)) {
    return { memoryId: entry.id, content, severity: 'warning', reason: 'sentence fragment — lacks context' };
  }

  const substantive = substantiveWordCount(content);
  if (substantive < 2) {
    return {
      memoryId: entry.id,
      content,
      severity: 'warning',
      reason: `only ${substantive} substantive word(s) — too vague`,
    };
  }

  if (content.length < 40 && hasNoSpecificity(content)) {
    return {
      memoryId: entry.id,
      content,
      severity: 'warning',
      reason: 'no specific details (names, paths, numbers, code)',
    };
  }

  const reason = automaticDefect(entry);
  if (reason !== null) {
    return { memoryId: entry.id, content, severity: 'warning', reason: `automatic memory defect: ${reason}` };
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

/** Which rows quality repair keeps whatever their defect; data, so a store on a worker thread applies it in its own
 * write. */
export interface RepairProtection {
  /** A person's pin, kept as 'pinned'. */
  readonly pinned: boolean;
  /** A raw receipt, kept as 'raw receipt'. */
  readonly raw: boolean;
  /** A note kept for good (canAutoDelete refuses it), kept as 'trusted imported note'. */
  readonly trusted: boolean;
  /** A row an object names, whose link repair could not restore, kept as 'backs an object'. */
  readonly objectBacked: boolean;
}

/** What quality repair keeps whatever the defect: a person's pin, a raw receipt, a trusted imported note, and a row
 * an object names, since the object's link could not be restored. */
export const PROTECTED_ROWS: RepairProtection = { pinned: true, raw: true, trusted: true, objectBacked: true };

/** Why repair must keep `entry` under `protection`, or undefined to let it go. */
export function repairKeeps(
  entry: MemoryEntry,
  backsObject: boolean,
  protection: RepairProtection,
): string | undefined {
  if (protection.pinned && entry.pinned) return 'pinned';
  if (protection.raw && entry.kind === 'raw') return 'raw receipt';
  if (protection.trusted && isKeptForGood(entry)) return 'trusted imported note';
  if (protection.objectBacked && backsObject) return 'backs an object';
  return undefined;
}
