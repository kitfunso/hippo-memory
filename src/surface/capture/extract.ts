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

/** The sorted offsets of the `**` markers a reading of a line removes. */
type Cutter = (line: string) => number[];

/** What capture read before it removed bold markers. */
const keepAll: Cutter = () => [];

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
const boldPairs: Cutter = (line) => pairedBold(line).sort((a, b) => a - b);

/** `line` without the two characters at each of the sorted `cuts`, built in one pass. */
function cutOut(line: string, cuts: readonly number[]): string {
  let out = '';
  let kept = 0;
  for (const at of cuts) {
    out += line.slice(kept, at);
    kept = at + 2;
  }
  return out + line.slice(kept);
}

/** How many of the sorted `values` are at most `limit`. */
function countUpTo(values: readonly number[], limit: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (values[middle] <= limit) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** A line of text and where it starts in the prose. */
interface Piece {
  text: string;
  at: number;
}

/** The text of a prose block with its markers cut, and where a range of it came from. */
interface Block {
  readonly text: string;
  sourceOf(from: number, to: number): [number, number];
}

function blockOf(pieces: readonly Piece[], cuts: Cutter): Block {
  const raw = pieces.map((piece) => piece.text).join(' ');
  const cutAt = cuts(raw);
  // Where each cut sits in the cut text, and where each piece starts in the raw text.
  const shifted = cutAt.map((at, k) => at - 2 * k);
  const starts: number[] = [];
  let sum = 0;
  for (const piece of pieces) {
    starts.push(sum);
    sum += piece.text.length + 1;
  }
  const toProse = (rawIndex: number): number => {
    const k = Math.max(0, countUpTo(starts, rawIndex) - 1);
    return pieces[k].at + Math.min(rawIndex - starts[k], pieces[k].text.length);
  };
  return {
    text: cutOut(raw, cutAt),
    sourceOf: (from, to) => [
      toProse(from + 2 * countUpTo(shifted, from)),
      toProse(to + 2 * countUpTo(shifted, to - 1)),
    ],
  };
}

function proseBlocks(prose: string, cuts: Cutter): Block[] {
  const blocks: Block[] = [];
  let pending: Piece[] = [];
  // Cut once the lines are joined, as a spec bullet is, so a bold pair that wraps a line goes whole.
  const flush = (): void => {
    if (pending.length > 0) blocks.push(blockOf(pending, cuts));
    pending = [];
  };
  let offset = 0;
  for (const line of prose.split('\n')) {
    const trimmed = line.trim();
    const end = offset + line.trimEnd().length;
    offset += line.length + 1;
    if (!trimmed || /^#+\s/.test(trimmed)) {
      flush();
      continue;
    }
    const bullet = trimmed.match(BULLET);
    if (bullet || !continues(trimmed, pending.at(-1)?.text)) flush();
    const text = bullet?.[1] ?? trimmed;
    pending.push({ text, at: end - text.length });
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

/** An item and the range of the prose it came from. */
interface Sourced {
  readonly item: ExtractedItem;
  readonly from: number;
  readonly to: number;
}

function extractSpecSections(prose: string, cuts: Cutter): Sourced[] {
  const bullets: Array<Piece & { to: number }> = [];
  let inSpecSection = false;
  let open = false;
  let offset = 0;
  for (const line of prose.split('\n')) {
    const trimmed = line.trim();
    const end = offset + line.trimEnd().length;
    offset += line.length + 1;
    if (SPEC_HEADING_PATTERNS.some((pattern) => pattern.test(trimmed))) {
      inSpecSection = true;
      open = false;
      continue;
    }
    if (/^#+\s/.test(trimmed) || /^[A-Z][a-z]+:$/.test(trimmed)) inSpecSection = false;
    const bullet = trimmed.match(BULLET);
    const last = bullets.at(-1);
    const wrapped: boolean =
      inSpecSection &&
      open &&
      !bullet &&
      trimmed !== '' &&
      (/^\s/.test(line) || continues(trimmed, last?.text));
    if (inSpecSection && bullet) {
      const text = bullet[1].trim();
      bullets.push({ text, at: end - text.length, to: end });
    } else if (wrapped && last) {
      last.text += ` ${trimmed}`;
      last.to = end;
    }
    open = inSpecSection && (bullet !== null || wrapped);
  }
  // Cut once the lines are joined, so a pair that wraps a line goes whole.
  return bullets
    .map(({ text, at, to }) => ({ content: cutOut(text, cuts(text)), from: at, to }))
    .filter(({ content }) => content.length <= MAX_CHARS && !content.endsWith('?'))
    .map(({ content, from, to }) => ({
      item: { content, category: 'spec', tags: ['spec', 'captured'] },
      from,
      to,
    }));
}

// The items of the spec bullets first, then those of each prose block.
function extractSourced(text: string, cuts: Cutter): Sourced[] {
  const prose = proseOnly(text);
  const found = extractSpecSections(prose, cuts);
  for (const block of proseBlocks(prose, cuts)) {
    const cutByAside = asideCutter(block.text);
    let cursor = 0;
    for (const sentence of completeSentences(block.text)) {
      const at = Math.max(block.text.indexOf(sentence, cursor), cursor);
      cursor = at + sentence.length;
      // A question asks rather than states; far over the bound, skip before any pattern runs.
      if (sentence.endsWith('?') || sentence.length > 2 * MAX_CHARS) continue;
      if (cutByAside(sentence, at)) continue;
      for (const [category, patterns] of CATEGORIES) {
        const item = extractFromPatterns(sentence, patterns, category);
        if (item) {
          const [from, to] = block.sourceOf(at, at + sentence.length);
          found.push({ item, from, to });
          break;
        }
      }
    }
  }
  return found;
}

/** Captures complete supported statements, each text parsed alone so a fence or heading in one never reaches the next.
 *  The first `userTexts` texts are a person's own words; on a repeat their copy wins, so it keeps `fromUser`. */
export function extractFromTexts(texts: readonly string[], userTexts = 0): ExtractedItem[] {
  const seen = new Set<string>();
  return texts
    .flatMap((text, i) =>
      extractSourced(text, boldPairs).map(({ item }) =>
        i < userTexts ? { ...item, fromUser: true } : item,
      ),
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

/** The items of one kind, in text order and so sorted by where they end. */
interface Track {
  readonly items: readonly Sourced[];
  readonly ends: readonly number[];
}

function trackOf(items: readonly Sourced[]): Track {
  return { items, ends: items.map(({ to }) => to) };
}

/** The items of `track` whose range overlaps [from, to). */
function overlapping(track: Track, from: number, to: number): Sourced[] {
  const found: Sourced[] = [];
  for (
    let k = countUpTo(track.ends, from);
    k < track.items.length && track.items[k].from < to;
    k++
  ) {
    found.push(track.items[k]);
  }
  return found;
}

/** The twins of `texts`: each old item pairs, one to one, with the new item whose lines overlap
 * its own, the same category first and then the larger overlap; a pair whose texts differ. */
export function boldTwins(texts: readonly string[], scrub: (text: string) => string): BoldTwin[] {
  const twins: BoldTwin[] = [];
  for (const text of texts.filter((t) => t.includes('**'))) {
    const fresh = extractSourced(text, boldPairs);
    // Spec bullets and prose sentences overlap each other, so each kind keeps its own order.
    const tracks = [trackOf(fresh.filter(({ item }) => item.category === 'spec'))];
    tracks.push(trackOf(fresh.filter(({ item }) => item.category !== 'spec')));
    const taken = new Set<Sourced>();
    for (const { item: old, from, to } of extractSourced(text, keepAll)) {
      const size = (found: Sourced): number => Math.min(found.to, to) - Math.max(found.from, from);
      const same = (found: Sourced): number => Number(found.item.category === old.category);
      const [match] = tracks
        .flatMap((track) => overlapping(track, from, to))
        .filter((found) => !taken.has(found))
        .sort((a, b) => same(b) - same(a) || size(b) - size(a));
      if (match === undefined) continue;
      taken.add(match);
      if (old.content !== match.item.content) {
        twins.push({ old: old.content, clean: scrub(match.item.content) });
      }
    }
  }
  return twins;
}
