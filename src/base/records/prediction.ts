// A prediction's closure states, shared by the store, the routes and the CLI flag checks.
import { createMemory, Layer, type MemoryEntry, type MemoryKind } from '../memory/entry.js';

export type ClosureState = 'open' | 'closed' | 'closed-unknown';

export const VALID_CLOSURE_STATES: ReadonlySet<ClosureState> = new Set<ClosureState>([
  'open',
  'closed',
  'closed-unknown',
]);

/** The memory row that mirrors a claim into recall, built here alone so every store keeps the
 * same row for it. */
export function predictionMirror(
  tenantId: string,
  claim: { readonly claimText: string; readonly classTag: string },
  baseHalfLifeDays: number,
  now: Date,
): MemoryEntry {
  return createMemory(
    claim.claimText,
    {
      tags: ['prediction', claim.classTag],
      layer: Layer.Semantic,
      confidence: 'observed',
      source: 'prediction',
      // SAFETY: 'distilled' is a valid MemoryKind literal (see entry.ts).
      kind: 'distilled' as MemoryKind,
      baseHalfLifeDays,
      tenantId,
    },
    now,
  );
}
