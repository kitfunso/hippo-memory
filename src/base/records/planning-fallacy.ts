// The planning-fallacy hint recall carries: pure shapes the domain fills and the api and CLI print.

/** On `RecallResult.planningFallacyHint` when a forward-claim query's closest class has closed
 * history, so the agent sees its own track record at the moment it forecasts. */
export interface PlanningFallacyHint {
  classTag: string;
  /** PredictionBaserate.summary verbatim, e.g. "Last 5 estimates in class migration-effort
   * averaged 2.10x actual". */
  baserateSummary: string;
  /** Tells this automatic hint apart from any later manual-override kind. */
  source: 'j3.2-auto';
  /** The regex match that fired, so the agent sees why the hint appeared and can discount a
   * misfire. */
  detectedPhrase: string;
  nClosed: number;
  /** Null only when every closed row had estimate_value=0, so the ratio is undefined. */
  meanRatio: number | null;
}

/** The forward-claim regex matched but no class overlaps the query's tokens, so the agent gets
 * the detection and a suggestion for re-tagging instead of a baserate. */
export interface PlanningFallacyWatching {
  detectedPhrase: string;
  /** 'no_class_match' when no class scored 1 or more on token overlap; 'tiebreak' when 2 or more
   * tied at the best. */
  reason: 'no_class_match' | 'tiebreak';
  /** One line the agent can act on or pass to the user, so the next forecast gets a baserate. */
  suggestion: string;
}

/** `hint` or `watching`, never both; neither when the mode is off, the regex misses or no class
 * has closed rows. */
export interface PlanningFallacyOutput {
  hint?: PlanningFallacyHint;
  watching?: PlanningFallacyWatching;
}
