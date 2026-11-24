export interface RecallProfile {
  readonly scoreForm: 'engine' | 'position';
  readonly scopeBoost: 'active' | 'filter';
  readonly candidateFloor: number;
  readonly globalReach: boolean;
  readonly resultCount: 'budget' | 'band';
  readonly goalBoost: { readonly ranked: boolean; readonly band: boolean };
}

/** The engine's list cut to a token budget, with the global store in reach. */
export const BUDGET_RANKED: RecallProfile = {
  scoreForm: 'engine',
  scopeBoost: 'active',
  candidateFloor: 0,
  globalReach: true,
  resultCount: 'budget',
  goalBoost: { ranked: true, band: false },
};

/** The engine's whole list, cut by the band composed from it. Tag, pin and recency boosts can
 * lift a row from deep in the BM25 order, so it loads 1,000. */
export const BAND_RANKED: RecallProfile = {
  scoreForm: 'engine',
  scopeBoost: 'active',
  candidateFloor: 1000,
  globalReach: false,
  resultCount: 'band',
  goalBoost: { ranked: true, band: true },
};

/** Every loaded row in load order, scored by its place and cut by the band; an engine the
 * request names reorders it. */
export const POSITION_BAND: RecallProfile = {
  scoreForm: 'position',
  scopeBoost: 'filter',
  candidateFloor: 0,
  globalReach: false,
  resultCount: 'band',
  goalBoost: { ranked: false, band: true },
};
