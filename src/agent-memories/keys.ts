// Hashes and keys for imported items, shared by the sync and the single-file adapters so they never drift apart.
import { createHash } from 'node:crypto';
import { FINGERPRINT_HEX_CHARS, ID_SUFFIX_CHARS } from '../util/token-text.js';

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/** The `#<hash>` part of a source: 16 hex of the full text, so an edit past the content cap is still seen. */
export function itemHash(text: string): string {
  return sha256Hex(text).slice(0, FINGERPRINT_HEX_CHARS);
}

/** Keys for a single-file store's items: `<heading slug>/<12 hex of the text>`, `~2`, `~3` on repeats. */
export function textItemKeys(items: readonly { readonly headingSlug: string; readonly text: string }[]): string[] {
  const seen = new Map<string, number>();
  return items.map(({ headingSlug, text }) => {
    const base = `${headingSlug}/${sha256Hex(text).slice(0, ID_SUFFIX_CHARS)}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}~${n}`;
  });
}
