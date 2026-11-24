import { createHash } from 'node:crypto';
import { BASIS_POINTS } from '../util/limits.js';

export type PilotArm = 'hippo' | 'holdout';

const BUCKET_HEX_CHARS = 8;

/** Deterministic split: the same session and rate always land in the same arm. */
export function hashArm(sessionId: string, rateBp: number): PilotArm {
  const hash = createHash('sha256').update(sessionId).digest('hex');
  const bucket = parseInt(hash.slice(0, BUCKET_HEX_CHARS), 16) % BASIS_POINTS;
  return bucket < rateBp ? 'holdout' : 'hippo';
}
