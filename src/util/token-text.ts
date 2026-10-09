import { createHash } from 'node:crypto';

/**
 * Rough token estimate: characters / 4. The single estimate behind every
 * token budget and ledger count in hippo.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Stable 16-hex-char hash of a rendered block, for change detection. */
export function blockHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}
