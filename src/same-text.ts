// One meaning of "the same text" for every path that skips, dedups or hides a memory: equal apart from spacing.
// A digit, sign or word that differs is a different value, so nothing looser may count as a copy.
import type { MemoryEntry } from './memory.js';

type Text = Pick<MemoryEntry, 'content'> & { source?: string };

export function duplicateKey(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Keys of every text a row holds word for word: its own, plus each source text inside a sleep-merged row. */
export function heldTextKeys(entry: Text): string[] {
  const own = duplicateKey(entry.content);
  const cut = entry.content.indexOf('\n\n');
  if (entry.source !== 'consolidation' || cut < 0) return [own];
  // Merged rows hold one "- " bullet per text; rows merged by older releases may hold one text alone after the header.
  const body = entry.content.slice(cut + 2);
  return [own, duplicateKey(body), ...`\n${body}`.split('\n- ').slice(1).map(duplicateKey)];
}

export function storedTextKeys(entries: readonly Text[]): Set<string> {
  return new Set(entries.flatMap(heldTextKeys));
}

/** A final result list without copies: drops each row a sleep-merged row in the list holds word for word, and each later copy of a text. */
export function dropHeldCopies<T>(rows: readonly T[], textOf: (row: T) => Text): T[] {
  const held = new Set(rows.flatMap((r) => heldTextKeys(textOf(r)).slice(1)));
  const seen = new Set<string>();
  return rows.filter((r) => {
    const keys = heldTextKeys(textOf(r));
    if (seen.has(keys[0]) || (keys.length === 1 && held.has(keys[0]))) return false;
    seen.add(keys[0]);
    return true;
  });
}
