// Tombstone keys are a pure hash of the normalized value, so the domain computes them without
// reaching the store.
import { createHash } from 'node:crypto';
import { textForms } from '../util/secret-detect.js';
import { heldTexts } from '../util/same-text.js';

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

/** The digest of each form a stored copy of `text` may hold, the stored form's first: a legacy row
 * or tombstone keeps the raw digest. */
export function contentDigests(text: string): readonly string[] {
  return textForms(text).map(rejectionDigest);
}

/** The digests a stored text answers to besides its own, sorted: each form of it and of each
 * bullet it holds, read as merged whatever wrote it, so the stored keys cover every row's source. */
export function otherDigests(content: string): string[] {
  const own = rejectionDigest(content);
  const texts = [content, ...heldTexts({ content, source: 'consolidation' })];
  return [...new Set(texts.flatMap(contentDigests))].filter((d) => d !== own).sort();
}
