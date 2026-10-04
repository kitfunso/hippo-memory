import { duplicateKey } from '../same-text.js';
import { assessAutomaticMemory } from '../automatic-memory-quality.js';

export interface ExtractedItem {
  content: string;
  category: string;
  tags: string[];
}

const DECISION_PATTERNS = [
  /\b(?:we(?:'ve| have)?|i(?:'ve| have)?|let's)\s+decid(?:ed|e)\b/i,
  /\b(?:let's|we(?:'ll| will| should)?)\s+(?:go with|do|use|try|build|implement|switch to)\b/i,
  /\b(?:going|went)\s+with\b/i,
  /\b(?:the plan is|plan:|decision:)\s/i,
];
const RULE_PATTERNS = [
  /\b(?:never|always|must(?:\s+not)?|do(?:n't| not)\s+ever)\s/i,
  /\b(?:the rule is|rule:|important:|critical:|remember:)\s/i,
  /\b(?:make sure|ensure)\s/i,
];
const ERROR_PATTERNS = [
  /\b(?:error|bug|gotcha|watch out|careful|warning|caveat|trap):\s/i,
  /\b(?:this broke|this breaks|this will break|broke because)\s/i,
  /\bthe (?:issue|problem|fix) (?:is|was)\s/i,
  /\b(?:don't forget|easy to miss):\s/i,
];
const PREFERENCE_PATTERNS = [
  /\b(?:prefer|use)\s+.+\s+(?:instead of|over|not)\s+/i,
  /\b(?:prefer|don't use|avoid|skip)\s/i,
  /\b(?:we(?:'re| are)\s+using|the stack is|we use)\s/i,
];
const SPEC_HEADING_PATTERNS = [
  /^#+\s*(?:features?|requirements?|specs?|specifications?|plan|design|architecture|interface|api|todo|tasks?|implementation|notes?)(?:\s|:|$)/i,
  /^(?:features?|requirements?|specs?|specifications?|plan|design|tasks?|implementation)(?:\s*:|$)/i,
];

/** Sentence splitting retained for digest callers; capture groups wrapped prose separately. */
export function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n/).map(s => s.trim()).filter(s => s.length > 5);
}

function proseOnly(text: string): string {
  let fence: string | null = null;
  return text.split('\n').map(line => {
    const marker = line.trimStart().match(/^(`{3,}|~{3,})/);
    if (marker) {
      if (fence === null) fence = marker[1][0];
      else if (marker[1][0] === fence) fence = null;
      return '';
    }
    return fence !== null || /^\s*>/.test(line) ? '' : line;
  }).join('\n');
}

function proseBlocks(text: string): string[] {
  const blocks: string[] = [];
  let pending: string[] = [];
  const flush = (): void => {
    if (pending.length > 0) blocks.push(pending.join(' '));
    pending = [];
  };
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || /^#+\s/.test(trimmed)) { flush(); continue; }
    const bullet = trimmed.match(/^(?:[-*]|\d+\.)\s+(.+)/);
    if (bullet || /^(?:decision|rule|error|bug|gotcha|important|critical|remember|plan):/i.test(trimmed)) flush();
    pending.push(bullet?.[1] ?? trimmed);
  }
  flush();
  return blocks;
}

function completeSentences(text: string): string[] {
  // Mask punctuation in inline code while retaining offsets into the unchanged source.
  const masked = text.replace(/`[^`\n]+`/g, span => 'x'.repeat(span.length));
  const segments = new Intl.Segmenter('en', { granularity: 'sentence' }).segment(masked);
  return [...segments].map(({ index, segment }) => text.slice(index, index + segment.length).trim());
}

function extractFromPatterns(sentence: string, patterns: readonly RegExp[], category: string): ExtractedItem | null {
  for (const pattern of patterns) {
    const match = pattern.exec(sentence);
    if (!match) continue;
    // Embedded parenthetical keywords do not support a detached assertion.
    const lead = sentence.slice(0, match.index);
    if ((lead.match(/[([{]/g) ?? []).length > (lead.match(/[)\]}]/g) ?? []).length) continue;
    const content = sentence
      .replace(/^(?:decision|plan|rule|important|critical|remember|error|bug|gotcha|watch out|careful|warning|caveat|trap|don't forget|easy to miss):\s*/i, '')
      .replace(/[.!?\s]+$/, '').trim();
    if (content.length <= 500 && assessAutomaticMemory(content).accepted) {
      return { content, category, tags: [category, 'captured'] };
    }
  }
  return null;
}

function extractSpecSections(text: string): ExtractedItem[] {
  const items: ExtractedItem[] = [];
  let inSpecSection = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (SPEC_HEADING_PATTERNS.some(pattern => pattern.test(trimmed))) {
      inSpecSection = true;
      continue;
    }
    if (/^#+\s/.test(trimmed) || /^[A-Z][a-z]+:$/.test(trimmed)) inSpecSection = false;
    const bullet = trimmed.match(/^(?:[-*]|\d+\.)\s+(.+)/);
    if (inSpecSection && bullet && bullet[1].length <= 500) {
      items.push({ content: bullet[1].trim(), category: 'spec', tags: ['spec', 'captured'] });
    }
  }
  return items;
}

/** Captures complete supported statements within the bound, preserving their relationships. */
export function extractFromText(text: string): ExtractedItem[] {
  const items: ExtractedItem[] = [];
  const seen = new Set<string>();
  const addIfNew = (item: ExtractedItem): void => {
    const key = duplicateKey(item.content);
    if (seen.has(key) || !assessAutomaticMemory(item.content).accepted) return;
    seen.add(key);
    items.push(item);
  };
  const prose = proseOnly(text);
  for (const item of extractSpecSections(prose)) addIfNew(item);
  const categories = [
    ['decision', DECISION_PATTERNS], ['rule', RULE_PATTERNS],
    ['error', ERROR_PATTERNS], ['preference', PREFERENCE_PATTERNS],
  ] as const;
  for (const block of proseBlocks(prose)) {
    for (const sentence of completeSentences(block)) {
      if (!assessAutomaticMemory(sentence).accepted) continue;
      for (const [category, patterns] of categories) {
        const item = extractFromPatterns(sentence, patterns, category);
        if (item) { addIfNew(item); break; }
      }
    }
  }
  return items;
}
