import { createHash } from 'node:crypto';
import type { MemoryEntry } from '../memory/memory.js';

export const SESSION_DIGEST_TAG = 'session-digest';

/** Facts extracted from a digest and DAG summaries over one inherit its tag, but they are not the digest itself. */
export function isSessionDigestRow(entry: Pick<MemoryEntry, 'source' | 'tags' | 'extractedFrom'>): boolean {
  return entry.source === SESSION_DIGEST_TAG && entry.tags.includes(SESSION_DIGEST_TAG) && !entry.extractedFrom;
}

/** Same session, same row: a second worker for one session updates the digest instead of adding one. */
export function sessionDigestId(tenantId: string, key: string): string {
  return `mem_${createHash('sha256').update(`${SESSION_DIGEST_TAG}\n${tenantId}\n${key}`).digest('hex').slice(0, 12)}`;
}
