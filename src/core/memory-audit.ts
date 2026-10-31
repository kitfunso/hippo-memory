// The memory-quality audit rules: pure functions of a row, so any store can be audited by them.
import { canAutoDelete, type MemoryEntry } from './memory.js';
import {
  automaticDefect, hasNoSpecificity, isFragment, isReleaseCommitNoise, substantiveWordCount,
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
