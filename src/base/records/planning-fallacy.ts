/** On `RecallResult.planningFallacyHint` when a forward-claim query's closest class has closed
 * history, so the agent sees its own track record at the moment it forecasts. */
export interface PlanningFallacyHint {
  classTag: string;
  baserateSummary: string;
  source: 'j3.2-auto';
  detectedPhrase: string;
  nClosed: number;
  meanRatio: number | null;
}

/** The forward-claim regex matched but no class overlaps the query's tokens, so the agent gets
 * the detection and a suggestion for re-tagging instead of a baserate. */
export interface PlanningFallacyWatching {
  detectedPhrase: string;
  reason: 'no_class_match' | 'tiebreak';
  suggestion: string;
}

/** `hint` or `watching`, never both; neither when the mode is off, the regex misses or no class
 * has closed rows. */
export interface PlanningFallacyOutput {
  hint?: PlanningFallacyHint;
  watching?: PlanningFallacyWatching;
}
