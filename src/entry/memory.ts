// The root entry's memory model: the entry shape and its strength, the session and card records, salience and the
// ambient state.
import {
  createMemory as createStoreMemory,
  DEFAULT_HALF_LIFE_DAYS,
  type CreateMemoryOptions,
  type MemoryEntry,
} from '../base/memory/memory.js';

export {
  MemoryEntry,
  Layer,
  EmotionalValence,
  ConfidenceLevel,
  DecayOptions,
  calculateStrength,
  resolveConfidence,
  confidenceFacets,
  type ConfidenceFacets,
  applyOutcome,
  generateId,
  computeSchemaFit,
  markRetrieved,
} from '../base/memory/memory.js';

/** The published signature keeps `baseHalfLifeDays` optional; hippo's own writers use the strict one in memory.ts. */
export function createMemory(content: string, options: Partial<CreateMemoryOptions> = {}): MemoryEntry {
  return createStoreMemory(content, {
    ...options,
    baseHalfLifeDays: options.baseHalfLifeDays ?? DEFAULT_HALF_LIFE_DAYS,
  });
}

export { SessionHandoff, HandoffOutcome, HandoffEvidence, isHandoffOutcome } from '../base/session/handoff.js';
export {
  Card,
  CardStatus,
  CardRun,
  CardComment,
  CardTransitions,
  isCardStatus,
  CARD_TRANSITIONS,
  CARD_LEASE_MS,
} from '../base/records/card.js';
export { computeSalience, SalienceDecision, SalienceResult, SalienceOptions } from '../base/memory/salience.js';
export {
  computeAmbientState,
  renderAmbientSummary,
  formatAmbientVector,
  AmbientState,
} from '../base/memory/ambient.js';
export { estimateTokens } from '../base/util/token-text.js';
export { tokenize, textOverlap } from '../base/util/tokenize.js';
export { isEmbeddingAvailable } from '../base/embeddings/local.js';
export { getEmbedding } from '../infra/local-embedder.js';
