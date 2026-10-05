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
const MAX_CHARS = 500;
const BULLET = /^(?:[-*]|\d+\.)\s+(?:\[[ xX]\]\s+)?(.+)/;
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
    // A list item may open a fence on its own line: "- ```".
    const marker = line.trimStart().match(/^(?:(?:[-*]|\d+\.)\s+)?(`{3,}|~{3,})/);
    if (marker) {
      if (fence === null) fence = marker[1][0];
      else if (marker[1][0] === fence) fence = null;
      return '';
    }
    // Quotes, table rows and indented code are not the speaker's own statements; nested list items are.
    return fence !== null || /^\s*[>|]/.test(line) || /^(?: {4}|\t)(?!\s*(?:[-*]|\d+\.)\s)/.test(line) ? '' : line;
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
    const bullet = trimmed.match(BULLET);
    // Only a lowercase line continues a wrapped sentence; a capitalised line is the next statement.
    if (bullet || !/^[a-z]/.test(trimmed) || /^(?:decision|rule|error|bug|gotcha|important|critical|remember|plan):/i.test(trimmed)) flush();
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

function insideBrackets(lead: string): boolean {
  return (lead.match(/[([{]/g) ?? []).length > (lead.match(/[)\]}]/g) ?? []).length;
}

function extractFromPatterns(sentence: string, patterns: readonly RegExp[], category: string): ExtractedItem | null {
  // A keyword inside brackets does not support a detached assertion; a later one outside them still does.
  const keyed = patterns.some((pattern) => [...sentence.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))]
    .some((match) => !insideBrackets(sentence.slice(0, match.index))));
  if (!keyed) return null;
  const content = sentence
    .replace(/^(?:decision|plan|rule|important|critical|remember|error|bug|gotcha|watch out|careful|warning|caveat|trap|don't forget|easy to miss):\s*/i, '')
    .replace(/[.!?\s]+$/, '').trim();
  return content.length <= MAX_CHARS && assessAutomaticMemory(content).accepted ? { content, category, tags: [category, 'captured'] } : null;
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
    const bullet = trimmed.match(BULLET);
    if (inSpecSection && bullet && bullet[1].length <= MAX_CHARS) {
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
      // A question asks rather than states; far over the bound, skip before any pattern runs.
      if (sentence.endsWith('?') || sentence.length > 2 * MAX_CHARS || !assessAutomaticMemory(sentence).accepted) continue;
      for (const [category, patterns] of categories) {
        const item = extractFromPatterns(sentence, patterns, category);
        if (item) { addIfNew(item); break; }
      }
    }
  }
  return items;
}
