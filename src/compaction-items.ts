// Reads the "Memories for hippo" list out of a compaction summary. Pure text in, text out: hooks and replay share it.
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
const ITEM_LINE = /^\s*(?:[-*]|\d+[.)])(?:\s+(.*))?$/;

/** The <summary> body of a PostCompact compact_summary with any <analysis> block removed; the whole text trimmed when there is no <summary> tag. */
export function compactSummaryBody(compactSummary: string): string {
  const text = compactSummary.replace(/<analysis>[\s\S]*?<\/analysis>/g, '');
  const open = text.lastIndexOf('<summary>');
  if (open < 0) return text.trim();
  const from = open + '<summary>'.length;
  const close = text.indexOf('</summary>', from);
  return text.slice(from, close < 0 ? undefined : close).trim();
}

function isHeading(line: string): boolean {
  const bare = line.replace(/^(?:[#*\s]|\d+\.)+/, '').replace(/[*:\s]+$/, '');
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
