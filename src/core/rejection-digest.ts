// Tombstone keys are a pure hash of the normalized value, so the domain computes them without reaching the store.
import { createHash } from 'node:crypto';

/** Normalize content for rejection digests: NFC, lowercase, collapse whitespace runs, trim. No punctuation stripping:
 * over-normalizing causes false refusals, worse than misses. */
export function normalizeValueForRejection(content: string): string {
  return content.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Full 64-char sha256 hex of the normalized content: a tombstone key needs collision resistance, not the 16-char
 * redaction hash used for query hashing. */
export function rejectionDigest(content: string): string {
  return createHash('sha256').update(normalizeValueForRejection(content)).digest('hex');
}
