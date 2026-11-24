import { createHash } from 'node:crypto';
import { FINGERPRINT_HEX_CHARS, ID_SUFFIX_CHARS } from '../../base/util/token-text.js';

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/** The `#<hash>` part of a source: 16 hex of the full text, so an edit past the content cap is
 * still seen. */
export function itemHash(text: string): string {
  return sha256Hex(text).slice(0, FINGERPRINT_HEX_CHARS);
}

/** Keys for a single-file store's items: `<heading slug>/<12 hex of the text>`, `~2`, `~3` on
 * repeats; a `seen` shared between calls counts the repeats across them. */
export function textItemKeys(
  items: readonly { readonly headingSlug: string; readonly text: string }[],
  seen = new Map<string, number>(),
): string[] {
  return items.map(({ headingSlug, text }) => {
    const base = `${headingSlug}/${sha256Hex(text).slice(0, ID_SUFFIX_CHARS)}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}~${n}`;
  });
}

/** A key's heading: all before its last `/`, so `<heading slug>/<12 hex>` gives the slug. */
export function headingOfKey(key: string): string {
  return key.slice(0, Math.max(0, key.lastIndexOf('/')));
}
