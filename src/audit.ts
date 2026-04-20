import type { MemoryEntry } from './memory.js';

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
