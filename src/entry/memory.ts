// The root entry's memory model: the entry and its strength, session and card records, salience and the ambient state.
// Each function keeps its optional `now` (HIPPO_FAKE_NOW, else the wall clock, read here) and its DecayOptions, from
// which this entry builds the StrengthModel the base functions take.
import {
  createMemory as createMemoryAt,
  markRetrieved as markRetrievedAt,
  type ConfidenceLevel,
  type CreateMemoryOptions,
  type MemoryEntry,
} from '../base/memory/entry.js';
import {
  calculateStrength as strengthAt,
  confidenceFacets as confidenceFacetsAt,
  resolveConfidence as resolveConfidenceAt,
  DEFAULT_HALF_LIFE_DAYS,
  PRODUCTION_STRENGTH,
  withLossAversion,
  type ConfidenceFacets,
  type ConfidenceInputs,
  type DecayBasis,
  type StrengthInputs,
  type StrengthModel,
} from '../base/memory/strength.js';
import { applyOutcome as applyOutcomeAt } from '../base/memory/keep-rules.js';
import {
  computeAmbientState as ambientStateAt,
  type AmbientState,
} from '../base/memory/ambient.js';
import {
  evalNow,
  evalSwitches,
  strengthModelUnder,
  type StrengthAblation,
} from '../infra/eval-switches.js';

export {
  MemoryEntry,
  Layer,
  EmotionalValence,
  ConfidenceLevel,
  generateId,
  computeSchemaFit,
} from '../base/memory/entry.js';
export type { ConfidenceFacets } from '../base/memory/strength.js';

/** calculateStrength's options: the decay basis, an eval's cut mechanisms and the root's loss-aversion ratio. */
export interface DecayOptions extends DecayBasis {
  /** EVAL-ONLY: the mechanisms an eval cuts; absent, production scoring. */
  ablation?: StrengthAblation;
  /** HIPPO_LOSS_AVERSION_RATIO as the root read it; absent is 1.0. */
  lossAversionRatio?: number;
}

/** The StrengthModel `options` names: production, cut where an eval says, with the root's ratio. */
function modelOf(options: Pick<DecayOptions, 'ablation' | 'lossAversionRatio'>): StrengthModel {
  const base = options.ablation ? strengthModelUnder(options.ablation) : PRODUCTION_STRENGTH;
  return withLossAversion(base, options.lossAversionRatio);
}

/** The published signature keeps `baseHalfLifeDays` optional; hippo's own writers name it. */
export function createMemory(
  content: string,
  options: Partial<CreateMemoryOptions> = {},
): MemoryEntry {
  const fields = {
    ...options,
    baseHalfLifeDays: options.baseHalfLifeDays ?? DEFAULT_HALF_LIFE_DAYS,
  };
  return createMemoryAt(content, fields, evalNow());
}

export function calculateStrength(
  entry: StrengthInputs,
  now: Date = evalNow(),
  options: DecayOptions = {},
): number {
  return strengthAt(entry, now, modelOf(options), options);
}

export function markRetrieved(
  entries: MemoryEntry[],
  now: Date = evalNow(),
  options: Pick<DecayOptions, 'ablation' | 'lossAversionRatio'> = {},
): MemoryEntry[] {
  return markRetrievedAt(entries, now, modelOf(options));
}

export function applyOutcome(
  entry: MemoryEntry,
  good: boolean,
  rules: Pick<DecayOptions, 'lossAversionRatio'> = {},
): MemoryEntry {
  return applyOutcomeAt(entry, good, evalNow(), modelOf(rules));
}

export function confidenceFacets(entry: ConfidenceInputs, now: Date = evalNow()): ConfidenceFacets {
  return confidenceFacetsAt(entry, now);
}

export function resolveConfidence(entry: MemoryEntry, now: Date = evalNow()): ConfidenceLevel {
  return resolveConfidenceAt(entry, now);
}

/** The ambient state under the environment's eval switches, at `now` or the entry's clock. */
export function computeAmbientState(entries: MemoryEntry[], now?: Date): AmbientState {
  return ambientStateAt(entries, now ?? evalNow(), evalSwitches().strength);
}

export {
  SessionHandoff,
  HandoffOutcome,
  HandoffEvidence,
  isHandoffOutcome,
} from '../base/session/handoff.js';
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
export {
  computeSalience,
  SalienceDecision,
  SalienceResult,
  SalienceOptions,
} from '../base/memory/salience.js';
export { renderAmbientSummary, formatAmbientVector, AmbientState } from '../base/memory/ambient.js';
export { estimateTokens } from '../base/util/token-text.js';
export { tokenize, textOverlap } from '../base/util/tokenize.js';
export { isEmbeddingAvailable } from '../base/embeddings/local.js';
export { getEmbedding } from '../infra/local-embedder.js';
