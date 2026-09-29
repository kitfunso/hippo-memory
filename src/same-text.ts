// One meaning of "the same text" for every path that skips, dedups or hides a memory: equal apart from spacing.
// A digit, sign or word that differs is a different value, so nothing looser may count as a copy.
import type { MemoryEntry } from './memory.js';

type Text = Pick<MemoryEntry, 'content'> & { source?: string; pinned?: boolean };

export function duplicateKey(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** A sleep-merged row's text: a header, a blank line, then each text as a "- " bullet with its later lines indented. */
export function mergedText(header: string, texts: readonly string[]): string {
  return `${header}\n\n${texts.map((t) => `- ${t.trim().replace(/\n/g, '\n  ')}`).join('\n')}`;
}

/** Each source text a sleep-merged row holds; a two-row merge by an older release kept one text whole after its header. */
export function heldTexts(entry: Text): string[] {
  const cut = entry.content.indexOf('\n\n');
  if (entry.source !== 'consolidation' || cut < 0) return [];
  const body = entry.content.slice(cut + 2);
  if (/^\[Consolidated from \d+ related memories\]$/.test(entry.content.slice(0, cut))) return [body];
  return `\n${body}`.split('\n- ').slice(1).map((t) => t.replace(/\n {2}/g, '\n'));
}

/** Keys of every text a row holds word for word: its own, plus each source text inside a sleep-merged row. */
export function heldTextKeys(entry: Text): string[] {
  return [duplicateKey(entry.content), ...heldTexts(entry).map(duplicateKey)];
}

export function storedTextKeys(entries: readonly Text[]): Set<string> {
  return new Set(entries.flatMap(heldTextKeys));
}

/** A final result list without copies: drops each unpinned row a sleep-merged row in the list holds word for word, and each later unpinned copy of a text. */
export function dropHeldCopies<T>(rows: readonly T[], textOf: (row: T) => Text): T[] {
  const held = new Set(rows.flatMap((r) => heldTextKeys(textOf(r)).slice(1)));
  const seen = new Set<string>();
  return rows.filter((r) => {
    const keys = heldTextKeys(textOf(r));
    const hidden = seen.has(keys[0]) || (keys.length === 1 && held.has(keys[0]));
    if (hidden && !textOf(r).pinned) return false; // rows merged by older releases can hold a pin's text
    seen.add(keys[0]);
    return true;
  });
}
