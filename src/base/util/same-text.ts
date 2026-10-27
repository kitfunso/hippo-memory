// One meaning of "the same text" for every path that skips, dedups or hides a memory: equal apart
// from spacing. A digit, sign or word that differs is a different value, so nothing looser may
// count as a copy.
import type { MemoryEntry } from '../memory/entry.js';
import { redactSecretsStrict } from './secret-detect.js';

type Text = Pick<MemoryEntry, 'content'> & { source?: string; pinned?: boolean };

/** `text` with each run of spaces one space, trimmed, secrets left as written. */
export function spacedText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The key of the text as stored, so a raw legacy row and its redacted twin are the same text. */
export function duplicateKey(text: string): string {
  return spacedText(redactSecretsStrict(text));
}

/** A 53-bit hash (cyrb53) of the text with every space removed: texts spacedText calls equal
 * share it. */
export function duplicateHash(text: string): number {
  const bare = text.replace(/\s+/g, '');
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < bare.length; i++) {
    const ch = bare.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** A sleep-merged row's text: a header, a blank line, then each text as a "- " bullet with its
 * later lines indented. */
export function mergedText(header: string, texts: readonly string[]): string {
  return `${header}\n\n${texts.map((t) => `- ${t.trim().replace(/\n/g, '\n  ')}`).join('\n')}`;
}

/**
 * Each source text a sleep-merged row holds; a two-row merge by an older release kept one text
 * whole after its header.
 */
export function heldTexts(entry: Text): string[] {
  const cut = entry.content.indexOf('\n\n');
  if (entry.source !== 'consolidation' || cut < 0) return [];
  const body = entry.content.slice(cut + 2);
  if (/^\[Consolidated from \d+ related memories\]$/.test(entry.content.slice(0, cut))) {
    return [body];
  }
  return `\n${body}`
    .split('\n- ')
    .slice(1)
    .map((t) => t.replace(/\n {2}/g, '\n'));
}

/** Keys of every text a row holds word for word: its own, plus each source text inside a
 * sleep-merged row. */
export function heldTextKeys(entry: Text): string[] {
  return [duplicateKey(entry.content), ...heldTexts(entry).map(duplicateKey)];
}

export function storedTextKeys(entries: Iterable<Text>): Set<string> {
  const keys = new Set<string>();
  for (const entry of entries) for (const key of heldTextKeys(entry)) keys.add(key);
  return keys;
}

/**
 * A final result list without copies: drops each unpinned row a sleep-merged row in the list holds
 * word for word, and each later unpinned copy of a text.
 */
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
