// Tombstone keys are a pure hash of the normalized value, so the domain computes them without
// reaching the store.
import { createHash } from 'node:crypto';
import type { MemoryEntry } from '../memory/entry.js';
import { identityText } from '../util/same-text.js';

/** Normalize content for rejection digests: NFC, lowercase, collapse whitespace runs, trim. No
 * punctuation stripping: over-normalizing causes false refusals, worse than misses. */
export function normalizeValueForRejection(content: string): string {
  return content.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Full 64-char sha256 hex of the normalized content: a tombstone key needs collision
 * resistance, not the 16-char redaction hash used for query hashing. */
export function rejectionDigest(content: string): string {
  return createHash('sha256').update(normalizeValueForRejection(content)).digest('hex');
}

/** The digest a reject or a lost conflict of this row writes: the identity of a lead-in row,
 * else the content, as today. */
export function tombstoneDigest(e: Pick<MemoryEntry, 'content' | 'leadIn'>): string {
  return rejectionDigest(e.leadIn ? identityText(e) : e.content);
}

/** Every tombstone this row matches: its content digest (value rejections and rows with no
 * lead-in), plus its identity digest when it has a lead-in. */
export function rowDigests(e: Pick<MemoryEntry, 'content' | 'leadIn'>): string[] {
  const own = rejectionDigest(e.content);
  return e.leadIn ? [own, tombstoneDigest(e)] : [own];
}
