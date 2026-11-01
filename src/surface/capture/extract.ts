import { duplicateKey } from '../../base/util/same-text.js';
import {
  assessAutomaticMemory,
  asideCloseOffset,
  QUOTE_MARK,
} from '../../base/memory/memory-quality.js';
import { ERROR_TAG } from '../../base/memory/entry.js';
import { blankCodeSpans, strongMarkers } from '../../base/memory/markdown-delimiters.js';

export interface ExtractedItem {
  content: string;
  category: string;
  tags: string[];
  /** A person said it, not the agent: capture pins a rule that carries this. */
  fromUser?: boolean;
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
const CATEGORIES = [
  ['decision', DECISION_PATTERNS],
  ['rule', RULE_PATTERNS],
  [ERROR_TAG, ERROR_PATTERNS],
  ['preference', PREFERENCE_PATTERNS],
] as const;
const MAX_CHARS = 500;
const BULLET = /^(?:[-*]|\d+\.)\s+(?:\[[ xX]\]\s+)?(.+)/;
const LABEL = /^(?:decision|rule|error|bug|gotcha|important|critical|remember|plan):/i;
const SENTENCE_END = /[.!?]["')\]]*$/;
const SPEC_HEADING_PATTERNS = [
  new RegExp(
    String.raw`^#+\s*(?:features?|requirements?|specs?|specifications?|plan|design|architecture|interface|api|todo|` +
      String.raw`tasks?|implementation|notes?)(?:\s|:|$)`,
    'i',
  ),
  /^(?:features?|requirements?|specs?|specifications?|plan|design|tasks?|implementation)(?:\s*:|$)/i,
];
// A list item may open a fence on its own line: "- ```".
const FENCE_OPEN = /^(?:(?:[-*]|\d+\.)\s+)?(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^(`{3,}|~{3,})\s*$/;
// Inline code and abbreviation dots never end a sentence; "etc." does when a capital follows.
const NO_BREAK = /(`+)[^`\n]+\1|\b(?:[Ee]\.g|[Ii]\.e|[Vv]s|[Cc]f)\.|\betc\.(?=\s+[a-z])/g;

/** CommonMark fences: a backtick run with a backtick after it is inline code, and only a bare
 * run as long closes. */
function proseOnly(text: string): string {
  let fence: string | null = null;
  let afterProse = false;
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trimStart();
      if (fence !== null) {
        const close = trimmed.match(FENCE_CLOSE);
        if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
        afterProse = false;
        return '';
      }
      const open = trimmed.match(FENCE_OPEN);
      if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
        fence = open[1];
        afterProse = false;
        return '';
      }
      // Quotes, table rows and indented code are not the speaker's own; indented code cannot
      // interrupt a paragraph or list item.
      const dropped =
        /^\s*[>|]/.test(line) || (!afterProse && /^(?: {4}|\t)(?!\s*(?:[-*]|\d+\.)\s)/.test(line));
      afterProse = !dropped && trimmed !== '' && !/^#{1,6}(?:\s|$)/.test(trimmed);
      return dropped ? '' : line;
    })
    .join('\n');
}

function masked(text: string): string {
  return text.replace(NO_BREAK, (span) => 'x'.repeat(span.length));
}

/**
 * A lowercase line continues the line above only when that line has not ended its sentence; "e.g."
 * at a line end has not.
 */
function continues(line: string, previous: string | undefined): boolean {
  if (previous === undefined || !/^[a-z]/.test(line) || LABEL.test(line)) return false;
  return !SENTENCE_END.test(masked(`${previous} ${line}`).slice(0, previous.length));
}

type LineCleaner = (line: string) => string;

/** Offsets of each `**` that pairs with the nearest opener before it. */
function pairedBold(line: string): number[] {
  const paired: number[] = [];
  const openers: number[] = [];
  // Blanked code spans keep every offset, so the markers found here are cut from the source.
  for (const marker of strongMarkers(blankCodeSpans(line, '`'))) {
    if (marker.inWord) continue;
    const opener = marker.close ? openers.pop() : undefined;
    if (opener !== undefined) paired.push(opener, marker.index);
    else if (marker.open) openers.push(marker.index);
  }
  return paired;
}

/** The segmenter splits after "**Label.**" and leaves the closing `**` on the next rule, so each
 * real pair goes; a glob, `2**10` or `**kwargs` has no partner and stays as written. */
function withoutBold(line: string): string {
  return pairedBold(line)
    .sort((a, b) => a - b)
    .reduceRight((rest, at) => rest.slice(0, at) + rest.slice(at + 2), line);
}

function proseBlocks(text: string, clean: LineCleaner): string[] {
  const blocks: string[] = [];
  let pending: string[] = [];
  const flush = (): void => {
    // Cleaned once the lines are joined, as a spec bullet is, so a span that wraps a line stays whole.
    if (pending.length > 0) blocks.push(clean(pending.join(' ')));
    pending = [];
  };
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || /^#+\s/.test(trimmed)) {
      flush();
      continue;
    }
    const bullet = trimmed.match(BULLET);
    const previous = pending.at(-1);
    if (bullet || !continues(trimmed, previous === undefined ? previous : clean(previous))) flush();
    pending.push(bullet?.[1] ?? trimmed);
  }
  flush();
  return blocks;
}

function completeSentences(text: string): string[] {
  // Masking keeps offsets, so each sentence is cut from the unchanged source.
  const segments = new Intl.Segmenter('en', { granularity: 'sentence' }).segment(masked(text));
  return [...segments].map(({ index, segment }) =>
    text.slice(index, index + segment.length).trim(),
  );
}

// A "(" after ":" or ";" is an emoticon, and one with a quote mark on both sides is quoted text.
function opensAside(text: string, at: number): boolean {
  const before = text[at - 1] ?? '';
  const quoted = QUOTE_MARK.test(before) && QUOTE_MARK.test(text[at + 1] ?? '');
  return text[at] === '(' && !/[:;]/.test(before) && !quoted;
}

// A sentence starts inside a cut aside: an unclosed "(" before it, an aside-closing ")" in it, and
// a word after that ")".
function asideCutter(block: string): (sentence: string, at: number) => boolean {
  const blanked = blankCodeSpans(block);
  let depth = 0;
  let seen = 0;
  return (sentence, at) => {
    while (seen < at) {
      if (opensAside(blanked, seen)) depth++;
      else if (blanked[seen] === ')') depth = Math.max(0, depth - 1);
      seen++;
    }
    if (depth === 0) return false;
    const close = asideCloseOffset(sentence);
    return close >= 0 && /[\p{L}\p{N}]/u.test(sentence.slice(close + 1));
  };
}

function insideBrackets(lead: string): boolean {
  return (lead.match(/[([{]/g) ?? []).length > (lead.match(/[)\]}]/g) ?? []).length;
}

function extractFromPatterns(
  sentence: string,
  patterns: readonly RegExp[],
  category: string,
): ExtractedItem | null {
  // A keyword inside brackets does not support a detached assertion; a later one outside them still
  // does.
  const keyed = patterns.some((pattern) =>
    [...sentence.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))].some(
      (match) => !insideBrackets(sentence.slice(0, match.index)),
    ),
  );
  if (!keyed) return null;
  const content = sentence
    .replace(
      new RegExp(
        String.raw`^(?:decision|plan|rule|important|critical|remember|error|bug|gotcha|watch out|careful|warning|` +
          String.raw`caveat|trap|don't forget|easy to miss):\s*`,
        'i',
      ),
      '',
    )
    .replace(/[.!?\s]+$/, '')
    .trim();
  return content.length <= MAX_CHARS ? { content, category, tags: [category, 'captured'] } : null;
}

function extractSpecSections(text: string, clean: LineCleaner): ExtractedItem[] {
  const bullets: string[] = [];
  let inSpecSection = false;
  let open = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (SPEC_HEADING_PATTERNS.some((pattern) => pattern.test(trimmed))) {
      inSpecSection = true;
      open = false;
      continue;
    }
    if (/^#+\s/.test(trimmed) || /^[A-Z][a-z]+:$/.test(trimmed)) inSpecSection = false;
    const bullet = trimmed.match(BULLET);
    const previousBullet = bullets.at(-1);
    const wrapped: boolean =
      inSpecSection &&
      open &&
      !bullet &&
      trimmed !== '' &&
      (/^\s/.test(line) ||
        continues(trimmed, previousBullet === undefined ? previousBullet : clean(previousBullet)));
    if (inSpecSection && bullet) bullets.push(bullet[1].trim());
    else if (wrapped) bullets[bullets.length - 1] += ` ${trimmed}`;
    open = inSpecSection && (bullet !== null || wrapped);
  }
  // Cleaned once the lines are joined, so a code span or a pair that wraps a line keeps its text.
  return bullets
    .map(clean)
    .filter((content) => content.length <= MAX_CHARS && !content.endsWith('?'))
    .map((content) => ({ content, category: 'spec', tags: ['spec', 'captured'] }));
}

// The items of the spec bullets first, then those of each prose block.
function extractUnits(text: string, clean: LineCleaner): ExtractedItem[][] {
  const prose = proseOnly(text);
  const units = [extractSpecSections(prose, clean)];
  for (const block of proseBlocks(prose, clean)) {
    const items: ExtractedItem[] = [];
    units.push(items);
    const cutByAside = asideCutter(block);
    let cursor = 0;
    for (const sentence of completeSentences(block)) {
      const at = Math.max(block.indexOf(sentence, cursor), cursor);
      cursor = at + sentence.length;
      // A question asks rather than states; far over the bound, skip before any pattern runs.
      if (sentence.endsWith('?') || sentence.length > 2 * MAX_CHARS) continue;
      if (cutByAside(sentence, at)) continue;
      for (const [category, patterns] of CATEGORIES) {
        const item = extractFromPatterns(sentence, patterns, category);
        if (item) {
          items.push(item);
          break;
        }
      }
    }
  }
  return units;
}

/** Captures complete supported statements, each text parsed alone so a fence or heading in one never reaches the next.
 *  The first `userTexts` texts are a person's own words; on a repeat their copy wins, so it keeps `fromUser`. */
export function extractFromTexts(texts: readonly string[], userTexts = 0): ExtractedItem[] {
  const seen = new Set<string>();
  return texts
    .flatMap((text, i) =>
      extractUnits(text, withoutBold)
        .flat()
        .map((item) => (i < userTexts ? { ...item, fromUser: true } : item)),
    )
    .filter((item) => {
      const key = duplicateKey(item.content);
      if (seen.has(key) || !assessAutomaticMemory(item.content).accepted) return false;
      seen.add(key);
      return true;
    });
}

/** A text an older capture, which kept every bold marker, stored for a line, and what capture
 * extracts from that line now. */
export interface BoldTwin {
  readonly old: string;
  readonly clean: string;
}

/** The twins of `texts`: both readings of a spec list or prose block pair by position when they
 * give the same number of items, and a pair whose texts differ is a twin. */
export function boldTwins(texts: readonly string[], scrub: (text: string) => string): BoldTwin[] {
  const twins: BoldTwin[] = [];
  for (const text of texts.filter((t) => t.includes('**'))) {
    const before = extractUnits(text, (line) => line);
    const after = extractUnits(text, withoutBold);
    // Blocks pair by position only when both readings find as many; the spec list is always first.
    const units = before.length === after.length ? before.length : 1;
    for (let u = 0; u < units; u++) {
      if (before[u].length !== after[u].length) continue;
      before[u].forEach((item, i) => {
        const fresh = after[u][i].content;
        if (item.content !== fresh) twins.push({ old: item.content, clean: scrub(fresh) });
      });
    }
  }
  return twins;
}
