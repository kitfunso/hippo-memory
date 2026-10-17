// The text rules of a compaction's "Memories for hippo" list: reading it out of a summary, which items become rows, and
// when one restates a held row. Pure text in, text out: hooks, replay and every store share it.
export const COMPACTION_ITEM_MAX_CHARS = 500;
export const COMPACTION_ITEM_ROW_CAP = 10;

export interface ParsedCompactionItems {
  found: boolean;
  items: string[];
}

export interface CompactionItemRows {
  rows: string[];
  tooLong: number;
  capped: number;
}

const HEADING = 'memories for hippo';
// `\S` parts the gap from the text, so a line that fails to match is scanned once, not once per space.
const ITEM_LINE = /^\s*(?:[-*]|\d+[.)])(?:\s+(\S.*)?)?$/;
const ANALYSIS_OPEN = '<analysis>';
const ANALYSIS_CLOSE = '</analysis>';
const HEADING_TRAILER = /[*:\s]/;

/** `text` minus each closed <analysis> block; a search, as a lazy pattern rescans the rest from every unclosed tag. */
function withoutAnalysis(text: string): string {
  let kept = '';
  let from = 0;
  for (;;) {
    const open = text.indexOf(ANALYSIS_OPEN, from);
    const close = open < 0 ? -1 : text.indexOf(ANALYSIS_CLOSE, open + ANALYSIS_OPEN.length);
    if (close < 0) return kept + text.slice(from);
    kept += text.slice(from, open);
    from = close + ANALYSIS_CLOSE.length;
  }
}

/**
 * `text` minus its trailing run of `*`, `:` and spaces; read from the end, as a `+$` pattern retries the run from each
 * character.
 */
function withoutHeadingTrailer(text: string): string {
  let end = text.length;
  while (end > 0 && HEADING_TRAILER.test(text[end - 1])) end--;
  return text.slice(0, end);
}

/**
 * The <summary> body of a PostCompact compact_summary with any <analysis> block removed; the whole text trimmed when
 * there is no <summary> tag.
 */
export function compactSummaryBody(compactSummary: string): string {
  const text = withoutAnalysis(compactSummary);
  const open = text.lastIndexOf('<summary>');
  if (open < 0) return text.trim();
  const from = open + '<summary>'.length;
  const close = text.indexOf('</summary>', from);
  return text.slice(from, close < 0 ? undefined : close).trim();
}

function isHeading(line: string): boolean {
  const bare = withoutHeadingTrailer(line.replace(/^(?:[#*\s]|\d+\.)+/, ''));
  return bare.toLowerCase() === HEADING;
}

/** found=false when no "Memories for hippo" heading; items in order, "none" dropped, never cut. */
export function parseCompactionItems(summaryBody: string): ParsedCompactionItems {
  const lines = summaryBody.split(/\r?\n/);
  let heading = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isHeading(lines[i])) {
      heading = i;
      break;
    }
  }
  if (heading < 0) return { found: false, items: [] };

  const after = lines.slice(heading + 1).join('\n');
  const end = after.indexOf('</summary>');
  const items: string[] = [];
  let current = -1;
  for (const line of (end < 0 ? after : after.slice(0, end)).split('\n')) {
    if (line.trim() === '') continue;
    const marker = ITEM_LINE.exec(line);
    if (marker) {
      const text = (marker[1] ?? '').trim();
      current = text === '' ? -1 : items.push(text) - 1;
    } else if (/^\s/.test(line)) {
      if (current >= 0) items[current] += ` ${line.trim()}`;
    } else {
      break;
    }
  }
  return { found: true, items: items.filter((item) => !/^none\.?$/i.test(item)) };
}

/** First COMPACTION_ITEM_ROW_CAP items of at most COMPACTION_ITEM_MAX_CHARS chars become rows. */
export function selectItemRows(items: readonly string[]): CompactionItemRows {
  const fitting = items.filter((item) => item.length <= COMPACTION_ITEM_MAX_CHARS);
  const rows = fitting.slice(0, COMPACTION_ITEM_ROW_CAP);
  return { rows, tooLong: items.length - fitting.length, capped: fitting.length - rows.length };
}

/** The marker redactSecretsStrict writes; an item holding it was a secret before it was stored. */
const REDACTED = '[REDACTED]';

/** The items that may become rows, as selectItemRows picks them from those with no secret; `note` hears what was left
 * out. */
export function writableItemRows(items: readonly string[], note: (message: string) => void): string[] {
  const usable = items.filter((item) => !item.includes(REDACTED));
  if (usable.length < items.length) note(`skipped ${items.length - usable.length} item(s) as secret`);
  const { rows, tooLong, capped } = selectItemRows(usable);
  if (tooLong > 0) note(`item too long: ${tooLong} kept in the record only`);
  if (capped > 0) note(`capped: ${capped} more kept in the record only`);
  return rows;
}

/** Words whose loss reverses or narrows a statement: "do not", "can't", "only", "unless". */
const PROTECTED_WORDS = new Set(['not', 'no', 'never', 'none', 'nor', 'without', 'cannot', 't', 'only', 'except',
  'unless', 'until']);
/** Below this share of the held text's words, an item is a fragment of something longer, not a restatement. */
const RESTATE_MIN_SHARE = 0.5;

/** The words restates compares: NFC, lower case, split on anything that is not a letter, mark, digit or `_`. */
export function itemWords(text: string): string[] {
  return text.normalize('NFC').toLowerCase().split(/[^\p{L}\p{M}\p{N}_]+/u).filter(Boolean);
}

/** True when `item` is `held` with words left out, in the same order, keeping every number and protected word. Spacing,
 * case and punctuation may differ. */
export function restates(item: readonly string[], held: readonly string[]): boolean {
  if (item.length === 0 || item.length < RESTATE_MIN_SHARE * held.length) return false;
  const kept = new Set(item);
  let next = 0;
  for (const w of held) {
    if (next < item.length && w === item[next]) next++;
    else if (!kept.has(w) && (PROTECTED_WORDS.has(w) || /\p{N}/u.test(w))) return false;
  }
  return next === item.length;
}
