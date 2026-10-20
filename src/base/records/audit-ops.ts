// The one list of audit ops: the AuditOp type, `hippo audit list --op` and GET /v1/audit?op= all read it.
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
  'decision_create', // emitted by saveDecision
  'decision_supersede', // emitted by saveDecision when --supersedes resolves to an active decision
  'decision_close', // emitted by closeDecision
  'incident_open', // emitted by saveIncident
  'incident_resolve', // emitted by resolveIncident
  'incident_close', // emitted by closeIncident
  'process_create', // emitted by saveProcess
  'process_supersede', // emitted by saveProcess on a supersession
  'process_close', // emitted by closeProcess
  'policy_create', // emitted by savePolicy
  'policy_supersede', // emitted by savePolicy on a supersession
  'policy_close', // emitted by closePolicy
  'skill_create', // emitted by saveSkill
  'skill_supersede', // emitted by saveSkill on a supersession
  'skill_close', // emitted by closeSkill
  'project_brief_create', // emitted by saveProjectBrief
  'project_brief_supersede', // emitted by saveProjectBrief on a supersession, including a refresh
  'project_brief_close', // emitted by closeProjectBrief
  'customer_note_create', // emitted by saveCustomerNote
  'customer_note_supersede', // emitted by saveCustomerNote on a supersession
  'customer_note_close', // emitted by closeCustomerNote
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
