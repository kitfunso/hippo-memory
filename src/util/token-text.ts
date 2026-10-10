import { createHash } from 'node:crypto';

/** Hex characters kept from a SHA-256 when it fingerprints a block, key or turn. */
export const FINGERPRINT_HEX_CHARS = 16;
/** Hex characters kept from a hash or UUID to build a short id. */
export const ID_SUFFIX_CHARS = 12;
/** Characters of a rejected-value or tombstone digest shown to a person. */
export const DIGEST_DISPLAY_CHARS = 12;
/** Length of the YYYY-MM-DD head of an ISO timestamp. */
export const DATE_PREFIX_CHARS = 10;
/** Characters of memory content shown as a one-line preview. */
export const CONTENT_PREVIEW_CHARS = 80;

/** Rough token estimate: characters / 4, the single estimate behind every token budget and ledger count. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Stable 16-hex-char hash of a rendered block, for change detection. */
export function blockHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, FINGERPRINT_HEX_CHARS);
}
