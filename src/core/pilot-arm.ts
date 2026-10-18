import { createHash } from 'node:crypto';

export type PilotArm = 'hippo' | 'holdout';

/** Deterministic split: the same session and rate always land in the same arm. */
export function hashArm(sessionId: string, rateBp: number): PilotArm {
  const bucket = parseInt(createHash('sha256').update(sessionId).digest('hex').slice(0, 8), 16) % 10000;
  return bucket < rateBp ? 'holdout' : 'hippo';
}
