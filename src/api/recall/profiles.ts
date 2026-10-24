// How each recall surface ranks, as data the one ranker reads; docs/recall-surface-differences.md names each field.

export interface RecallProfile {
  /** 'engine' ranks with the engine (physics or hybrid) and keeps its list and scores; 'position' keeps every loaded
   * row in load order, reordered only by an engine the request names, and scores each row by its place. */
  readonly scoreForm: 'engine' | 'position';
  /** The scope the engine boosts: the request's active scope, or the scope the request filters on. */
  readonly scopeBoost: 'active' | 'filter';
  /** The fewest rows the lexical load reads, whatever the scorer window asks for. */
  readonly candidateFloor: number;
  /** Whether a global store in reach is searched beside the caller's own. */
  readonly globalReach: boolean;
  /** 'budget' has the engines spend the request's token budget and stops the list at its limit; 'band' ranks every
   * row and leaves the cut to the band composed from the list. */
  readonly resultCount: 'budget' | 'band';
  /** Whether the goal-stack boost runs over the ranked list, and again over the band's position scores. */
  readonly goalBoost: { readonly ranked: boolean; readonly band: boolean };
}

/** `hippo recall` and `hippo explain`. */
export const CLI_RECALL: RecallProfile = {
  scoreForm: 'engine',
  scopeBoost: 'active',
  candidateFloor: 0,
  globalReach: true,
  resultCount: 'budget',
  goalBoost: { ranked: true, band: false },
};

/** MCP `hippo_recall`. Tag, pin and recency boosts can lift a row from deep in the BM25 order, so it loads 1,000. */
export const MCP_RECALL: RecallProfile = {
  scoreForm: 'engine',
  scopeBoost: 'active',
  candidateFloor: 1000,
  globalReach: false,
  resultCount: 'band',
  goalBoost: { ranked: true, band: true },
};

/** HTTP `GET /v1/memories` and the `retrieve` library call. */
export const HTTP_RECALL: RecallProfile = {
  scoreForm: 'position',
  scopeBoost: 'filter',
  candidateFloor: 0,
  globalReach: false,
  resultCount: 'band',
  goalBoost: { ranked: false, band: true },
};
