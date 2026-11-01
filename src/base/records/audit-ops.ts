// The one list of audit ops: the AuditOp type, `hippo audit list --op` and GET /v1/audit?op= all
// read it.
export const AUDIT_OPS = [
  'remember',
  'recall',
  'promote',
  'supersede',
  'forget',
  'archive_raw',
  'auth_revoke',
  'auth_create', // emitted by api.authCreate
  'outcome',
  'pin', // emitted by api.memoryPin
  'consolidate', // emitted once per api.sleep invocation
  'audit_prune', // emitted by pruneAuditLog after each retention prune
  'summary_marked_dirty', // emitted by markSummaryDirty on the 0->1 transition
  'summary_marked_clean', // emitted by clearSummaryDirtyAfterBuild after the buildDag child-link loop
  'summary_rebuilt', // emitted by applyRebuildResult on a successful sleep-cycle rebuild
  'predict_create', // emitted by savePrediction
  'predict_close', // emitted by closePrediction
  'predict_baserate', // emitted by computePredictionBaserate
  'recall_autodebias_hint', // emitted by computePlanningFallacyOutput on success
  'recall_autodebias_hint_no_class_match', // telemetry: forward-claim detected, no class scored
  'recall_autodebias_hint_tiebreak', // telemetry: forward-claim detected, two or more classes tied
  'recall_anchor_detected_query_repeat', // emitted by the anchoring detector when the same query returns the same top-1
  // emitted by the anchoring detector when one memory wins top-1 across distinct queries
  'recall_anchor_detected_memory_dominance',
  'recall_anchor_skipped_no_session', // telemetry: no sessionId, so ring tracking was skipped
  'recall_availability_detected', // emitted when the availability/recency-bias hint fires
  // The typed-object ops: the objects store group writes each one with its row, from saveObject (a
  // create, or a supersede when the save replaces an active row), closeObject, openIncident and
  // resolveOpenIncident.
  'decision_create',
  'decision_supersede',
  'decision_close',
  'incident_open',
  'incident_resolve',
  'incident_close',
  'process_create',
  'process_supersede',
  'process_close',
  'policy_create',
  'policy_supersede',
  'policy_close',
  'skill_create',
  'skill_supersede',
  'skill_close',
  'project_brief_create',
  'project_brief_supersede',
  'project_brief_close',
  'customer_note_create',
  'customer_note_supersede',
  'customer_note_close',
  'mv_rescue', // emitted by consolidate() per rescued entry when config.memoryValue.enabled
  'reject_value', // emitted by the `hippo reject` verb
  'reject_refusal', // emitted when the rejection guard refuses a write
  'unreject_value', // emitted by the `hippo unreject` verb
  'conflict_resolve', // emitted by resolveConflict on every resolution path
  'half_life_migrate', // emitted by migrateDefaultHalfLife with the rescaled ids
  'dormant_restore', // emitted by api.dormantRestore
  'auth_grant', // emitted by api.authGrant
  'auth_ungrant', // emitted by api.authUngrant
  'quarantine', // emitted by recordQuarantine inside remember's write transaction
  'quarantine_approve', // emitted by api.quarantineApprove
  'quarantine_reject', // emitted by api.quarantineReject
  'agent_memory_restore', // emitted by the agent memory sync when a deleted note comes back
  'agent_memory_set_aside', // emitted by the agent memory sync when a note is deleted or refused
  'project_merge', // emitted by `hippo projects merge --apply` with every id it touched
  'project_repair', // emitted by `hippo projects repair --apply` with every id it touched
  'quality_repair', // emitted by `hippo audit repair --apply` for each memory it moved to dormant storage
] as const;

export type AuditOp = (typeof AUDIT_OPS)[number];
