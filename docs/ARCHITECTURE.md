# Architecture notes

Design provenance for src/: which roadmap item or release added a behaviour, schema history, measurements and alternatives tried. Source comments keep the one-line reason; this file keeps the record, quoted from the comment it came from.

## History moved out of src/ comments, by module

### src/api/assemble.ts
- `AssembleResult.truncated`: With v1.6.2's NEWEST-cap semantics, the items[] array represents the freshest tail of the session
- `assemble`: F4 (v1.6.5): byte compare canonical UTC ISO timestamps. ~50× faster than localeCompare and chronological by virtue of the timestamp invariant documented in src/memory.ts above MemoryEntry.

### src/api/audit.ts
- `auditList`: Read-only — no audit emit (matches A5: cmdAuditList does not record a 'recall'-style read event).

### src/api/auth.ts
- `AuthCreateOpts.role`: v1.12.3: authorization role for the new key. Defaults to `'admin'` for back-compat with v1.12.0-v1.12.2 (the api_keys.role column DEFAULT also resolves to 'admin' if omitted from the INSERT).
- `AuthCreateResult.role`: v1.12.3: the role bound to the new key (admin | member).
- `authList`: Read-only — no audit emit (matches A5).
- `authGrant`: Grant `keyId` read access to one restricted `scope` (ROADMAP Part VIII EI2). Admin only.

### src/api/context-types.ts
- `getContext` (section banner): getContext (extracted from cmdContext — Task 5 of the api.ts refactor)
- `ContextOpts`: Extracted from `cmdContext` in `cli.ts` in Episode A of the api.ts refactor.
- `ContextOpts`: Scope narrow (T5 execute decision): rendering opts (`format`, `framing`, `rendered`) and host-side opts (`auto`) are NOT included here. The print helpers (`printContextMarkdown`, `printActiveTaskSnapshot`, `printHandoff`, `printSessionEvents`) are shared with `cmdRecall` / `cmdSnapshot` / `cmdHandoffShow` — moving them into api.ts would expand T5 to also rewire those commands. CLI handles rendering + auto-resolution. Episode B can add `api.renderContext` once a shared rendering need actually materializes.
- `ContextOpts.includeRecent`: quality floor (`isWorthSurfacing`, DF3): rows hippo wrote meet the automatic check, a person's rows the older floor.
- `ContextOpts.currentSessionId`: DF1 (docs/plans/2026-08-23-df1-snapshot-lifecycle.md, T2): the calling session's id.
- `ContextOpts.prompt`: Z1: raw hook-payload prompt; only the pinned-only branch reads it, gated on `pinnedInject.promptRecall`.
- `ContextResultEntry.promptRecall`: Z1: admitted by the prompt-recall gate, not the recent-N backfill or a pin.

### src/api/context.ts
- `ambientAdmitEntry`: - S4 secret veto is UNCONDITIONAL: neither crossProject nor contextProjectIsolation:false re-includes secrets.
- `ambientAdmitEntry`: - S2 envelope parity: private/quarantine scopes never inject unless `exactScope` names one.
- `ambientAdmitEntry`: - S3 origin partition: other-project rows are excluded unless `includeCrossProject`.
- `ambientSecretAdmit`: v39 S4: the secret half of the ambient policy on its own, for callers that apply their own scope rule.
- `loadAmbientEntries`: DF3's quality floor runs on the recent-N slice AFTER this load, so the load counts by it too, or it stops short of a store whose newest rows are junk.

### src/api/dormant.ts
- `restoreDormant`: A restore is a labelled "forgot it, then needed it" event: the signal a learned lifecycle (ROADMAP LC3) trains on.

### src/api/forget.ts
- `reject / unreject / listRejections` (section banner): AT1: reject / unreject / listRejections docs/plans/2026-08-15-at1-rejected-value-tombstone.md §4

### src/api/outcome.ts
- `outcome`: `opts.traceId` (LC1, docs/plans/2026-08-02-lc1-recall-trace-persistence.md): OPTIONAL additive opt so a programmatic caller can link this outcome to the recall_traces row it judges.
- `outcome`: if (good && updated.tags.includes(CHURN_STALE_TAG)) { // FE2: a good outcome reconfirms the entry
- `outcome`: LC1: link the outcome to its trace, recording only the ids actually credited (post tenant-filtering, matches appliedIds).
- `outcomeForLastRecall` (section banner): outcomeForLastRecall (last-recall wrapper around outcome — Task 3)

### src/api/promote.ts
- `PromoteResult`: Note: `promoteToGlobal` does not currently take a tenantId override — it reads the entry from the local root via `readEntry` (no tenant filter) and preserves the entry's existing tenantId on the global side. Task 4 may tighten this once writeEntry/readEntry thread tenant context.
- `SupersedeResult`: Mirrors `cmdSupersede` in cli.ts (without flag-driven layer/tag/pin overrides — A1 keeps the API minimal; the CLI handler will continue to handle those flags and pass the resolved values once Task 4 lands).
- `ArchiveRawOpts`: We DO NOT emit a second audit event here to avoid double-emitting the archive_raw op (unlike Task 1 remember/forget where the underlying helpers hardcode actor='cli').
- `ArchiveRawOpts.afterArchive`: Connector idempotency hook (v0.39 commit 3).

### src/api/recall-types.ts
- `RecallOpts.scorerWindow`: F3 (v1.7.0): scorer-window opt-in. When set, `loadSearchEntries` loads up to `scorerWindow` candidates. When undefined (default), the existing behaviour is preserved: store-internal 200-row default, which every release before v1.7.0 silently relied on.
- `RecallOpts.scorerWindow`: **Input is library-only at v1.7.0.** Transport exposure for the input planned for v1.7.1 alongside the deferred-queue items that need a wider candidate pool (e.g. mean-of-children summary re-rank).
- `RecallOpts.summarizeOverflow`: v1.5.0 DAG-aware recall. Set to false to disable and get the pre-v1.5 strict-limit behaviour.
- `RecallOpts.freshTailCount`: v1.5.2 fresh-tail.
- `RecallOpts.freshTailSessionId`: v1.6.2 fresh-tail session scope.
- `RecallOpts.includeContinuity`: All three lookups are tenant-scoped to ctx.tenantId via the v0.40+ store helpers.
- `RecallOpts.sessionId`: v1.7.4 -- when set AND `(ctx.tenantId, sessionId)` has active goals AND `goalTag` is unset, `api.recall` applies the dlPFC goal-stack boost lifted from CLI cmdRecall. Pre-v1.7.4 the boost was CLI-only (env-driven via HIPPO_SESSION_ID). Undefined preserves v1.7.3 behaviour (no boost).
- `RecallOpts.goalTag`: v1.7.4 -- explicit goal-tag override. When set, the goal-stack boost is SUPPRESSED (mirrors the CLI's `goalTag === ''` gate from v0.38).
- `RecallOpts.recallHistory`: v0.33 / J1 anchoring detector.
- `RecallOpts.suppressAvailabilityHint`: v1.13.x / J2 — when true, api.recall does NOT compute or emit the availabilityHint. Mirrors how J1 only computes anchoring when opts.recallHistory is supplied.
- `RecallOpts.explain`: A7 recall-trace. When undefined/false (default), both fields are absent on EVERY band so the response shape is byte-identical to pre-A7. The api pipeline applies only goal-boost; the richer CLI stages (interference/value/utility/reranker/retrieval-count-downweight) are A7.2.
- `RecallOpts.suppressRecallTrace`: LC1 (docs/plans/2026-08-02-lc1-recall-trace-persistence.md) / F2 fix.
- `RecallResultItem.isSummary`: v1.5.0 DAG-aware recall (docs/plans/2026-05-05-dag-recall.md Task 2).
- `RecallResultItem.substitutedFor`: Caller can drill into these via `drillDown` (Task 3) to recover the original detail.
- `RecallResultItem.isFreshTail`: v1.5.2 fresh-tail (docs/plans/2026-05-05-dag-recall.md Task 4).
- `RecallResultItem.rerankTrace`: A7 recall-trace.
- `RecallResultItem.rerankPipeline`: A7 recall-trace. Distinguishes the api pipeline (goal-boost only) from the richer CLI pipeline (A7.2 will unify them).
- `RecallResult.windowSize`: F3 (v1.7.0): scorer window actually used for this recall.
- `RecallResult.suppressionSummary`: v1.12.13 / C5 — WYSIATI cutoff transparency.
- `RecallResult.planningFallacyHint`: v0.32 / J3.2 — auto-injected planning-fallacy hint.
- `RecallResult.anchoringHint`: v0.33 / J1 (v1.13.2) — recall-recurrence anchoring hint. Populated when api.recall's `opts.recallHistory` snapshot + the just-computed top-1 satisfy R1 (query_repeat) or R2 (memory_dominance).
- `RecallResult.availabilityHint`: v1.13.x / J2 — availability/recency-bias hint.
- `RecallSuppressionSummary`: v1.12.13 / C5 — WYSIATI cutoff transparency (Track C Pineal Gland, C5).
- `RecallSuppressionSummary.suppressedByInterference`: v0.33 / J1 (v1.13.2): incremented by 1 PER PIPELINE when that pipeline's own R2 memory_dominance verdict fires (via the J1 anchoring detector — see `detectAnchoring()` in src/recall-history.ts).
- `RecallSuppressionSummary.suppressedByInterference`: Future B4-depth work may add additional sources (e.g. vlPFC inhibition scores). No `interference_suppression` table is built — the v1.12.13 doc that referenced one was speculative; J1 uses caller-side in-memory rings instead.

### src/api/recall.ts
- `buildSuppressionSummary`: Pass-through identity today; kept as a helper so future field additions (B4 interference counter wiring, etc.) land at one site.
- `recall`: **api.recall does NOT mutate `index.last_retrieval_ids`** (v1.11.5 contract lock).
- `retrieve`: Mode-aware recall that strengthens each returned row; never writes last_retrieval_ids (v1.11.5 lock).

### src/api/remember.ts
- `RememberOpts.afterWrite`: Used by ingestion connectors (E1.3+) to stamp idempotency / cursor rows atomically with the memory row
- `RememberOpts.untrusted`: CD5: connector-ingested content an agent doesn't control; gates detectInstruction. CLI/HTTP/MCP never set this.

### src/api/sleep.ts
- `sleep` (section banner): sleep (extracted from cmdSleepCore Phase 2-6 — Task 4 of the api.ts refactor)
- `SleepResult.secretSkipped`: v1.25.0: count of memories the auto-share secret veto withheld this sleep
- `SleepResult.rejectedSkipped`: AT1: count of auto-share candidates the GLOBAL store's rejection tombstone refused this sleep (docs/plans/2026-08-15-at1-rejected-value-tombstone.md plan §3 — copy paths must not let one rejected candidate abort the batch).
- `SleepResult.graph`: E3 sleep enqueue-hook: graph re-extraction totals across the tenants rebuilt this sleep.
- `sleep`: Tenant scope note: sleep operates on the WHOLE hippoRoot (all tenants in it), matching the pre-refactor cmdSleepCore behavior. Correct for a CLI maintenance op invoked by the operator. Episode B (v1.11.4) exposed this over HTTP `/v1/sleep` with loopback-only enforcement (per-request guard in the handler plus serve()'s boot-time host check). The TODOS.md per-tenant scoping follow-up remains open for the day non-loopback serving lands — at that point the route will need an admin-role gate OR api.sleep itself will need to scope dedup / audit / delete by ctx.tenantId.
- `SleepPhases`: v1.12.2: Test-only DI seam shape for `sleep`'s phase dependencies.
- `sleep`: v1.12.2: resolve phase dependencies, allowing test-only `__phases` override to inject deterministic throws for mid-phase failure coverage.
- `sleep`: v1.11.5: phase counters for the consolidate audit emit (in finally).

### src/api/tokens.ts
- `recordTokens`: Record memory text handed to an agent in the token ledger (ROADMAP TE0).
- `failureSummary`: Failed tool calls by outcome, and repeats across sessions, over the last `days` days (default 30); ROADMAP CD13.

### src/api/types.ts
- `Actor`: Actor identity + authorization role for a Context. v1.12.0 A5 v2 sub-1. Before v1.12.0, Context.actor was a bare string. v1.12.0 promotes it to an object carrying both the audit-log subject (formerly the string itself) and a role for /v1/sleep admin gating. Audit helpers continue accepting `string` — callers pass `ctx.actor.subject`.
- `Actor.scopes`: EI2: restricted scopes a member key may read (auth.ts grantScope). Unused for admin actors.

### src/audit-prune.ts
- (module header): Audit log retention pruning (v1.12.9).
- (module header): Closes TODOS A5 v2 M6: "Audit log unbounded growth. Add a daily `audit prune` cron + `hippo audit prune --older-than 90d` CLI in v2. Mind regulatory retention floors (HIPAA, SOX, GDPR) — the prune should be opt-in per tenant and emit its own audit trail event."
- `PruneAuditOpts.tenantId`: Tenant scope. Required — prune is always tenant-scoped per the A5 v2 design.

### src/audit.ts
- `CJK_LETTERS`: SCOPE ... other spaceless scripts - Thai, Khmer, Burmese, Lao - still hit the original one-word failure. Their behavior is byte-identical to before this change, so nothing regressed; widening the script set is a separate, deliberately-scoped follow-up rather than another mid-episode guess at this predicate.
- `audit log primitives` (section banner): A5 audit log primitives (append-only mutation trail)

### src/auth.ts
- `CreateApiKeyOpts.role`: v1.12.0 A5 v2 sub-1: 'admin' | 'member'. Defaults to 'admin' (backward-compat for callers that don't specify).
- `createApiKey`: v1.12.0: 6-column INSERT including role. Boot-order guarantee: openHippoDb runs runMigrations synchronously before returning the db handle, so migration v26 (adds role column) is in place before this INSERT runs.
- `ValidateResult.role`: v1.12.0 A5 v2 sub-1: 'admin' | 'member'. Present only when valid=true.
- `ValidateResult.scopes`: EI2: scope grants for this key. Present only when valid=true.
- `grantScope`: EI2: grant `keyId` read access to one restricted `scope`. Idempotent.
- `ungrantScope`: EI2: revoke `keyId`'s grant on `scope`. Not an error when no such grant exists.
- `listScopeGrants`: EI2: every restricted scope `keyId` may read.
- `ApiKeyListItem.role`: v1.12.3: authorization role bound to the key. SELECT extended to read the `role` column (added in schema migration v26 by v1.12.0 sub-1).
- `ApiKeyListItem.scopes`: EI2: restricted scopes this key may read.

### src/autolearn.ts
- `deduplicateLesson`: L9: `tenantId` is opt-in.

### src/availability.ts
- (module header): J2 — Availability-bias detector (Track J: biases-over-memory-state)
- (module header): Soft warning ONLY (ROADMAP-RESEARCH.md Track J discipline note): this never filters, reorders, or suppresses a result. It surfaces a hint the calling agent may choose to act on, exactly like J1 anchoringHint / J3 planningFallacyHint / C5 suppressionSummary.

### src/capture-error.ts
- (module header): Every failure, stored or not, goes to the failure log (ROADMAP CD13).

### src/capture/command.ts
- `CaptureOptions.tenantId`: L9: tenant scope for the dedup read in `cmdCaptureCore`. When provided AND `global` is false, the dedup check only considers this tenant's existing memories. Undefined preserves pre-1.12.1 host-wide dedup behaviour.
- `cmdCaptureCore`: Dedup only against rows this capture's reader sees: another tenant's rows (L9), or another project's, are hidden from it, so they must not stop its own copy.
- `captureEntry`: A3: kind defaults to 'distilled'. capture.ts extracts curated items from session output (not raw transcript chunks), so distilled is correct. If a future variant captures full raw session text, it MUST set kind: 'raw' and route deletions through archiveRawMemory(). See MEMORY_ENVELOPE.md. L9: the dedup read above is scoped by options.tenantId — the WRITE must match, or scoped-dedup-passes-then-default-tenant-write breaks the per-tenant contract. Mirror the dedup-read guard: when global: true, the global store is host-wide and tenant is irrelevant (createMemory's default 'default' applies). When global: false, options.tenantId scopes the write to the same tenant as the dedup.
- `captureOne`: AT1 (plan §3 containment): one rejected item must not abort the rest of this capture's items.

### src/capture/compact.ts
- `transcriptWorkingState`: Compaction fires when a big tool_result lands (CX7), so the last human and assistant turns can sit megabytes back
- `transcriptWorkingState`: X9: these fields skip the capture content gate and reach a prompt, so the strict scrub runs. The caps protect the re-injection token budget and never split a surrogate pair (X2); `hippo snapshot save` stays uncapped.
- `runPreCompact`: X3: the PreCompact hook fires in every Claude Code project, including ones that never ran `hippo init`, so gate before any store-opening call
- `saveDerivedSnapshot`: Per-field merge (X1): a tool-heavy tail whose only user turns are tool_result arrays derives an empty task even though the summary is non-empty.

### src/capture/extract.ts
- `DECISION_PATTERNS`: T1 (DF2): each pattern now carries TWO capture groups — group 1 is the discriminating keyword (plus its trailing separator, verbatim), group 2 is the content that follows it. Previously only the after-keyword content was captured, so a negation like "never" / "must not" was discarded and a prohibition inverted into an instruction ("Never use X" stored as "use X"). `extractFromPatterns` reassembles group1 + a clause-bounded group2 (T2, via `boundToClause` below) rather than reading a single fixed-width group — group 2's own reach is widened to {1,500} because the true stopping point is now found by content, not counted characters. Keeping the keyword in its own group (rather than folding it into one bigger capture) matters: `boundToClause` must scan for a clause boundary only in group 2, never in group 1 — several keywords end in their own colon ("error:", "rule:", "decision:") which is not a clause boundary in the prose sense and would wrongly truncate the capture down to just the keyword if scanned.
- `PREFERENCE_PATTERNS`: PREFERENCE_PATTERNS[0] keeps its pre-DF2 two-capture-group shape (match[1]-only, unbounded) — out of scope here, backlogged. See extractFromPatterns' reference check against this exact array element.
- `boundToClause`: T2 (DF2): bound a keyword+content capture to its clause instead of a fixed character count.
- `cleanExtract`: T2 trailing cleanup: clause-bounding can cut inside a parenthetical and leave an unmatched trailing ')'
- `extractFromPatterns`: PREFERENCE_PATTERNS[0] is the one pattern left out of T1/T2 (see comment at its definition) — its match[1] keeps its pre-DF2, unbounded shape rather than going through clause-bounding.
- `extractFromPatterns`: T1 preserves the keyword only when it carries SEMANTIC SIGN — a negation or modality ("never", "must not", "do not ever", "always"). Dropping those inverts the meaning, which is the whole point of T1. ... (AT1's rejected-value digest hashes the bare content).

### src/churn-git.ts
- `module header`: Git subprocess helpers for FE2 churn-staleness (src/invalidation.ts).

### src/cli/audit.ts
- `audit subcommands banner`: Audit log subcommands (A5 stub auth — `hippo audit list`)
- `handleAudit`: `audit list` and `audit prune` -> A5 audit-log subcommands.

### src/cli/auth.ts
- `auth subcommands banner`: Auth subcommands (A5 stub auth)
- `cmdAuthCreate`: v1.12.3: --role flag surfaces the api_keys.role column added v1.12.0 sub-1. Accepts 'admin' | 'member' only; anything else exits 1 with a typed error so a typo doesn't silently default to admin.
- `formatKeyRow`: v1.12.3: role column surfaced
- `cmdAuthScopeGrant`: EI2: `hippo auth grant|ungrant <key_id> <scope>`, routed through api so the tenant, restricted-scope and audit checks live in one place.

### src/cli/curate.ts
- `cmdForget`: A3: raw memories (Slack / GitHub connector ingestion) are append-only — a BEFORE-DELETE trigger aborts any delete. archiveRaw is the sanctioned removal path; it records ctx.actor as the archiver for provenance.
- `cmdResolve`: AT1: --reject-loser tombstones the loser's normalized digest so it cannot be re-asserted later, in addition to removing it (kind-aware). --reason defaults to a conflict-context string when omitted (resolve already has the conflict id + keepId; unlike `hippo reject`, a reason is not strictly required here).
- `reject banner`: AT1: reject / rejections / unreject docs/plans/2026-08-15-at1-rejected-value-tombstone.md §4
- `cmdReject`: --reason is REQUIRED (plan §4, grill issue 4): the tombstone stores no content, so reason is its only human-readable identity.
- `cmdQuarantine`: `hippo quarantine [list] [--all] [--json] [--global]`, `quarantine approve <id>`, `quarantine reject <id>` (CD5 poisoning defence).

### src/cli/dag.ts
- `cmdDag`: Tree view: v0.30 / E5 renders L3 entity profiles as roots (with L2 children indented), then orphan L2 summaries (no L3 parent) at top level. Pre-E5 behavior was L2-only roots; rendering now covers L3.
- `cmdDag`: Orphan L2 summaries (no L3 parent) at top level — pre-E5 default shape.
- `cmdDrillDown`: v0.30 / E5: --depth N walks N levels down (default 1, hard cap 10). L4 fold: reject out-of-range explicitly (no silent clamp).

### src/cli/decisions.ts
- `prediction banner`: E2 prediction first-class object (v0.31) docs/plans/2026-05-26-e2-prediction-object.md
- `predictBaserate`: J3 reference-class / planning-fallacy detector

### src/cli/goals.ts
- `goal banner`: `hippo goal <push|list|complete|suspend|resume>` — B3 dlPFC depth (Task 10)

### src/cli/remember.ts
- `parseKindFlag`: CLI surface intentionally restricted: 'raw' is reserved for ingestion connectors (E1.x: Slack/Jira/Gmail) that route deletions through archiveRawMemory.
- `parseRememberEnvelope`: A3 envelope flags
- `cmdRemember`: A5 stub auth: stamp tenant_id from env (HIPPO_TENANT) so recall isolation can filter on this row. Default tenant 'default' for unauthenticated CLI.
- `handleRemember`: B2 v1.12.6 — validate --owner on the thin-client path too. Failure on this path exits early so the user gets the same validation experience whether or not a server is up.
- `handleRemember`: The salience gate is NOT in richFlag and the route does not apply it, so a routed remember stores what a direct one would skip. Measured 2026-09-07, tracked in TODOS.md; do not read this list as covering salience.

### src/cli/session-hooks.ts
- `COMPACT_RESUME_EVENT_CONTENT_CAP`: X8: session-event content is capped at print time only — the shared printSessionEvents stays untouched for every other caller.
- `cmdCompactResume`: Without a payload session_id the X5 cross-restore guard below can never fire, so a timed-out empty read must not reach the print path.
- `cmdCompactResume`: A sub-agent's payload carries its parent's session id, so X5 would pass and restore the parent's snapshot into it.
- `restoreCompactSnapshot`: X5: concurrent sessions must not cross-restore. Only suppress when BOTH ids are present and differ — either side missing, or a manual invocation with no payload session_id, still prints.
- `restoreCompactSnapshot`: X12: re-injected state is background reference, not instructions: the framing line the model actually sees at every compaction.
- `cmdSessionEnd`: Bounded read (DF1 T3, docs/plans/2026-08-23-df1-snapshot-lifecycle.md): extracts transcript_path + session_id for the detached worker's argv.
- `cmdSessionEndWorker`: DF1 T3: close the ending session's own active task snapshot AFTER sleep+capture complete — neither producer (runPreCompact, `hippo snapshot save`) runs inside session-end, so this can never destroy same-run work. Scoped to `--session-id`: a concurrent session's active snapshot is untouched (closeTaskSnapshotsForSession's own WHERE clause). Absent session id -> no-op plus one log line; session-end is not guaranteed to fire at all (crash, kill -9), so the freshness bound in loadFreshActiveTaskSnapshot is the backstop layer, not this close. Handoff write happens BEFORE the snapshot close below, while the snapshot writeSessionEndHandoff reads is still active.

### src/cli/slack.ts
- `slack banner`: Slack subcommands (E1.3 — `hippo slack backfill` / `hippo slack dlq list`)

### src/cli/status.ts
- `cmdTokens`: `hippo tokens [--days <n>] [--json] [--global]`: the token ledger (ROADMAP TE0). Tokens of memory text handed to agents per surface, blocks the per-prompt hook skipped as unchanged (TE2) and the tokens that saved,
- `cmdFailures`: `hippo failures [--days <n>] [--json] [--global]`: failed tool calls by outcome, and repeats across sessions (CD13).
- `cmdFailures`: Counts, not a rate: a share means little without a holdout arm to compare against (CD11).

### src/cli/transfer.ts
- `cmdWatch`: AT1 (plan §3 containment): mechanical content from a failed command — a rejection-guard refusal here must not crash the watcher. Skip silently (loud enough via the message below) and still exit with the wrapped command's real exit code.
- `cmdImport`: K1 vault import: a FOLDER importer that mirrors the connector pattern (kind='raw' + tag provenance + archiveRaw deletions), so it dispatches separately from the single-file `importer` function-pointer slot below.
- `handlePeers`: D4 v1.12.10: tenant-scoped by default. --all-tenants restores the pre-D4 host-wide view for the rare operator who genuinely wants cross-tenant peer discovery.

### src/compare.ts
- `module header`: A true LEAF module ... a type-only import back to search.ts would still create the search.ts <-> physics.ts ESM import cycle this module exists to avoid (r2 critic HIGH, docs/plans/2026-07-09-recall-determinism.md T2).
- `compareEntryIdentity`: The metadata keys are only computed on a content tie, which is rare post-T1 (path-tag embedding fix), so the per-compare Set/sort cost never lands on the hot path.
- `comparePhysicsResultsBy`: `ScoredPhysicsResult` (physics.ts) carries `{ memoryId, baseScore, clusterAmplification, finalScore }` -- NO `entry`/`content` in scope at that layer, so `compareEntryIdentity` cannot apply directly (plan T2 shape (c)).

### src/config.ts
- `pinnedInject.skipUnchanged`: Skip a block identical to the one already injected this session (ROADMAP TE2). Default true. Needs a session id from the hook payload.
- `pinnedInject.promptRecall`: Z1: gate the hook's backfill on the prompt's own content instead of the five newest memories. Default true since 1.55.0: overlap tied but median tokens fell 847 to 533 (docs/evals/2026-09-26-z1-prompt-recall-result.md).
- `pinnedInject.promptRecallMetric`: Z1: overlap metric for the prompt-recall gate. Default 'jaccard' (tuned, docs/evals/2026-09-26-z1-prompt-recall-result.md).
- `pinnedInject.promptRecallThreshold`: Z1: minimum overlap score to admit a candidate. Default 0.04 (tuned).
- `pinnedInject.promptRecallMinShared`: Z1: minimum shared tokens to admit a candidate. Default 2.
- `pinnedInject.promptRecallMaxItems`: Z1: max prompt-recall entries injected per prompt. Default 5 (tuned).
- `pinnedInject.promptRecallCandidates`: Z1: FTS candidate pool size per store before gating. Default 100.
- `contextProjectIsolation`: Memory scope isolation (v39): when true (default), ambient context ... See docs/plans/2026-07-01-memory-scope-isolation.md.
- `memoryValue`: LC2-E3: opt-in learned memory-value rescue veto on the sleep decay pass (docs/plans/2026-08-10-lc2-e3-mv-wiring.md). Default OFF — the frozen E2 weights (src/memory-value-weights.ts) only run when explicitly enabled; no other knobs in v1 (the rescue budget is a code constant tied to E2 evidence, not user-tunable).
- `churnStaleness`: FE2: tags a memory `churn-stale` when its named file/symbol/script changed since storage. Default OFF - FE3 measures before it flips.

### src/connectors/github/dlq.ts
- `IngestHook`: with memoryId=null. The webhook route wires the real hook in Task 14.

### src/connectors/github/ingest.ts
- `ingestEvent`: AT1 (plan §3 containment): a tombstone hit is a PERMANENT skip, not a transient failure — never DLQ-retry it. Mark the idempotency key seen exactly like the empty-body branch above so a GitHub retry of the same delivery acks as done, not error.

### src/connectors/github/transform.ts
- `module header`: kind is the literal 'raw' (E1.x connector boundary, see src/importers.ts).
- `module header`: owner is `user:github:<login>`. Required by the v0.40.0 provenance gate.

### src/connectors/slack/dlq.ts
- `writeToDlq`: v0.39 commit 3: writeToDlq is now bucket-aware. `bucket` defaults to

### src/connectors/slack/ingest.ts
- `rejectedValueResult`: AT1 (plan §3 containment): a tombstone hit is a PERMANENT skip, not a transient failure — never DLQ-retry it (retrying would just hit the same refusal forever). Mark the event seen exactly like the empty-body branch above so a Slack retry acks as done, not error.

### src/connectors/slack/signature.ts
- `VerifyOpts.previousSecret`: Previous signing secret during a rotation. v0.39 commit 3: deploy with

### src/connectors/slack/transform.ts
- `messageToRememberOpts`: kind is the literal 'raw' (E1.x connector boundary, see src/importers.ts).
- `messageToRememberOpts`: the deletion path (Task 9) looks up by this string. owner is non-null whenever a row is written. Required by the v0.40.0

### src/connectors/slack/types.ts
- `SlackMessageEvent`: v0.40.0 provenance gate requires a non-null `owner`, so transform.ts

### src/connectors/slack/web-client.ts
- `module header`: fetcher is the one Task 13's `backfillChannel` consumes.

### src/connectors/slack/workspaces.ts
- `module header`: Slack workspace registration helpers (T2B follow-up, 2026-05-24).
- `module header`: Before T2B, populating this table required direct SQL — fine for a single-machine deployment, awkward for operators with multiple workspaces. These helpers give the CLI (`hippo slack workspaces add|list|remove`) a clean surface.

### src/consolidate/conflicts.ts
- `detectConflicts`: LC2-E3 (opt-in, default off): ids rescued by this cycle's decay pass. detectConflicts recomputes its own strength>=DECAY_THRESHOLD survivor filter independently of the decay pass above; without this bypass, rescued entries would be silently re-excluded from conflict detection every cycle even though the decay pass just decided to keep them. Default empty set: flag-off behavior is unchanged.
- `detectConflicts`: CD5: an unreviewed quarantined row must not taint a visible memory as conflicted.

### src/consolidate/decay.ts
- `decayPass`: LC2-E3 (opt-in, default off; docs/plans/2026-08-10-lc2-e3-mv-wiring.md): flag OFF keeps the single-phase loop below byte-identical to pre-E3 behavior (pre-registered gate G2). Flag ON restructures into two phases: phase 1 classifies every entry (condemned vs survivor) with ZERO commits; phase 2 runs rescueSet over the per-tenant candidate groups, then commits — rescued entries get the standard survivor bookkeeping refresh (stored strength + effective confidence; no half-life edits, no rank-derived writes) and are pushed to survivors so they fully participate in this cycle's merge/physics/conflict passes; non-rescued condemned entries follow the existing pendingDeletes/result.removed/details path.

### src/consolidate/llm-passes.ts
- `dagRebuildPass`: 1.8. DAG summary rebuild — drain dirty queue from E2's child-write hooks
- `dagRebuildPass`: Consumer of E2's summary_dirty flag. Walks dirty L2 summaries, regenerates
- `entityProfilePass`: E5 phase: aggregate per-entity L2 summaries (e.g. all the speaker:Alice

### src/consolidate/merge.ts
- `mergePass`: AT1 consolidation-loop fix (docs/plans/2026-08-15-at1-rejected-value-tombstone.md): reuses the single consolidateDb handle opened lazily in consolidate() for the whole non-dry-run consolidate — see that declaration's comment. Only needed for real writes — a dry-run preview never reaches batchWriteAndDelete's guard bypass, so there is nothing here for it to protect against.
- `mergeCluster`: Immediate ranking is deliberately unchanged: the 2026-06-10 DAG slice-1 eval measured that dropping children below a worse-retrieving summary regresses budget-bounded QA (docs/evals/). The stored

### src/consolidate/run.ts
- `ConsolidationResult.tracesSkippedMixedScope`: T7: sessions skipped because their events span two derivation scopes.
- `ConsolidationResult.summariesRebuilt`: v0.30 / E3 — rebuild phase observability. Failed and zero-child counts are first-class so downstream callers (CLI eval, HTTP /v1/sleep response) see structured data, not a parsed details string.
- `ConsolidationResult.entityProfilesCreated`: v0.30 / E5 — L3 entity-profile build count
- `lazyConsolidateDb`: AT1 rejection-guard db handle (docs/plans/2026-08-15-at1-rejected-value-tombstone.md): covers BOTH the auto-promote pass (1.4) and the merge pass (3) — both build deterministic content that batchWriteAndDelete writes through the guard's bypass, so both need a producer-side tombstone check before pushing to pendingWrites.

### src/consolidate/sleep.ts
- `consolidate`: L9: host-wide by design. Consolidation runs across all tenants in one pass — per-tenant filtering would create N consolidation runs per host with no cross-tenant dedup. The api.sleep audit row tags this with the admin synthetic actor; see api.ts:2050 for the rationale.
- `auditRescues`: One audit row per rescue (attributability, D1). Written here, AFTER batchWriteAndDelete has committed this cycle's writes/deletes (and after conflict detection + run logging), not inline in the decay pass — same durability posture as api.ts's top-level 'consolidate' summary audit row (written only once the whole sleep has completed). Writing it earlier would assert rescues for a cycle whose effects never landed if a later phase threw. Real writes only — dry-run previews the decision (details line above) but persists nothing.

### src/consolidate/traces.ts
- `promoteSessionTraces`: Auto-trace currently runs in a single-tenant context (the env-resolved tenant for this process). Multi-tenant deployments that want consolidation across all tenants need a per-tenant loop layered on top of this — tracked in docs/plans/2026-05-02-continuity-tables-tenant-scope.md.
- `sessionTrace`: T7: a mixed-scope session would otherwise leak into one trace.
- `traceRejected`: AT1 (same producer-side pattern as the merge pass below): traceExistsForSession only sees rows CURRENTLY in the store — once a rejected trace is removed, that idempotency check no longer blocks regeneration, and this write would otherwise reach batchWriteAndDelete's guard bypass unchecked, resurrecting it every sleep. Check under THE ENTRY'S OWN stamped tenantId (read off `trace` after createMemory — never guess the tenant) + the built content's digest. A hit skips the push entirely: not counted as promoted, not added to survivors.

### src/customer-notes.ts
- module header: E2 customer_note first-class object - the LAST E2 object (docs/plans/2026-06-01-e2-customer-note-object.md).
- module header: Entity-scoping is a free-form `customer` column (the `entities` table is unbuilt - E3.1 planned - so an FK is deferred).
- module header: It has NO assembler/renderer (the simplest E2 object): the contribution is purely the entity-scoping dimension.

### src/dag.ts
- `DagBuildResult.rejected`: AT1: clusters skipped because the LLM-synthesized summary landed on a rejected value (plan §3 containment — per-cluster catch, not a whole- phase abort). Member re-parenting writes are unaffected by construction (same id + same content = guard-exempt), so this only ever counts summary-creation refusals.
- `createClusterSummaryEntry`: Schema v25: cache descendant_count + earliest/latest_at on the summary row so DAG-aware recall (docs/plans/2026-05-05-dag-recall.md Task 2) can reason about scope without walking the children.
- `summarizeCluster`: AT1 (plan §3 containment): a refused LLM-synthesized summary skips ONLY this cluster — the sleep cycle continues to the next one. The member re-parenting writes below never run for a skipped cluster (there is no summary id to parent them under). The tombstone check itself is tenant-scoped for free: writeEntry -> writeEntryDbOnly -> upsertEntryRow calls checkRejectionGuard(db, entry.tenantId ?? 'default', ...) (store/entry-writes.ts), reading tenantId off the entry being written. Now that summaryEntry carries home.tenantId instead of the implicit 'default', the guard consults that tenant's tombstones — no separate check needed here (unlike consolidate.ts's merge pass, which pre-checks via findRejectedValue because it writes through batchWriteAndDelete's bypassRejectionGuard path instead of writeEntry).
- `summarizeCluster`: v0.30 / E3 — cancel the cascade of dirty-marks fired by member writeEntry calls (E2 hook on writeEntryDbOnly in store/entry-writes.ts). The summary we just built IS fresh, no rebuild needed. Without this, E3 in the SAME sleep cycle would re-rebuild every new summary (2x LLM cost).
- section banner: v0.30 / E3 of DAG live-coupling — rebuildDirtySummaries orchestrator
- `DagRebuildResult.refused`: tombstone-hit refusals — dirty cleared, content NOT written (T4 split from `rebuilt`)
- `rebuildDirtySummaries`: v0.30 / E3 — sleep-cycle phase that drains the dirty L2 summary queue.
- `rebuildDirtySummaries`: T4: applyRebuildResult returns { changed, refused } — a tombstone hit (rebuild content matches a previously-rejected value) increments `refused`, not `rebuilt`. Dirty still clears either way; only the stat split changed (docs/plans/2026-08-15-hardening-at1-followups.md T4).
- section banner: v0.30 / E5 of DAG live-coupling — L3 entity profile build path
- `EntityProfilesBuildResult.rejected`: AT1: clusters skipped because the profile summary landed on a rejected value (plan §3 containment). Kept distinct from `failed` (LLM null / rate-limit) — a tombstone hit is a deliberate refusal, not an error.
- `profileCluster`: AT1 (plan §3 containment): per-cluster catch — skip this cluster, count, log once. The member re-linking writes below never run for a skipped cluster (mirrors buildDag above).
- `profileCluster`: E3 born-dirty cancellation, same dance as buildDag L161-168 but for L3. Pass source='buildEntityProfiles-clean' to distinguish in audit. Args: (root, id, tenantId, actor, source).
- `buildEntityProfiles`: v0.30 / E5 — build L3 entity profiles by clustering L2 summaries with shared entity tags.
- `buildEntityProfiles`: Born-dirty cancellation (E3 lesson): after linking L2 children to the new L3 (each link write fires E2 hook on L3 via widened markSummaryDirtyInTx), call clearSummaryDirtyAfterBuild with source='buildEntityProfiles-clean' so E3 sleep-cycle rebuild doesn't re-rebuild the freshly-built L3 this same cycle.

### src/db/migrations/v14.ts
- migration v14: A3 provenance envelope: kind, scope, owner, artifact_ref.

### src/db/migrations/v16.ts
- migration v16: A5 stub auth: add tenant_id to all data tables. Single-tenant per deployment; multi-tenant enforcement deferred to v2 (full A5). The columns are needed now so future B-track tables don't have to backfill.
- migration v16: A5 stub auth: api_keys (scrypt-hashed; plaintext returned to caller exactly once)

### src/db/migrations/v17.ts
- migration v17: E1.3 Slack ingestion: idempotency log, per-channel backfill cursors, DLQ. See docs/plans/2026-04-29-e1.3-slack-ingestion.md.

### src/db/migrations/v19.ts
- migration v19: v0.39 commit 3 (Slack hardening): widen slack_dlq with bucketing,

### src/db/migrations/v20.ts
- migration v20: v0.39 commit 4 (GDPR Path A backfill): redact every existing raw_archive.payload_json

### src/db/migrations/v21.ts
- migration v21: per-row mirror cleanup tracking. Replaces the global gdpr_v20_mirror_cleanup meta gate (which made the reaper one-shot and silently swallowed failed unlinks). With this column the reaper processes only rows WHERE mirror_cleaned_at IS NULL, sets the timestamp on success, and leaves it NULL on any unlink failure so the next openHippoDb retries automatically.

### src/db/migrations/v24.ts
- migration v24: v1.3.0 GitHub connector schema (codex round 1, 2026-05-04).
- migration v24: Rollback-safety guard (codex P0 #2). Any binary < 1.2.1 lacks the generic *:private:* default-deny and would leak github:private:* rows if it opened this DB. The startup guard in v1.2.1+ refuses to open a DB whose min_compatible_binary is newer than its own version.

### src/db/migrations/v25.ts
- migration v25: v1.5.0 DAG-aware recall — cache summary metadata so the assembler can reason about scope without re-walking the DAG. See docs/plans/2026-05-05-dag-recall.md Task 1.

### src/db/migrations/v26.ts
- migration v26: v1.12.0 A5 v2 sub-1: add role column to api_keys for the admin/member distinction that gates /v1/sleep.
- migration v26: No min_compatible_binary bump: old binaries (v1.11.x) ignore the column on SELECTs that don't name it
- migration v26: v1.12.7 defensive: also guard on tableExists.

### src/db/migrations/v27.ts
- migration v27: v1.12.7 self-heal — re-assert the v16 schema (api_keys + audit_log).

### src/db/migrations/v28.ts
- migration v28: E1 of 5-episode DAG live-coupling arc (docs/plans/2026-05-25-dag-e1-schema-v28.md). Adds dirty-flag persistence for the existing DAG layer's level-2 summaries so E2 (child-write propagation) and E3 (sleep-cycle rebuild) have somewhere to write + read the staleness signal. Adds dag_level_3_built_at as a column (Keith Q5 pick: lets E5 entity- profile build path land without a second migration).
- migration v28: No min_compatible_binary bump: old binaries (v1.12.x) ignore the columns on SELECTs that don't name them
- migration v28: Reserved for E5: buildEntityProfiles will set this on level-3 rows when they're created.

### src/db/migrations/v29.ts
- migration v29: E2 prediction first-class object (docs/plans/2026-05-26-e2-prediction-object.md). Adds a canonical predictions table for J3 reference-class / planning-fallacy detector (a follow-up episode).
- migration v29: J3 computes accuracy (clean vs regressed) from (estimate_value, actual_value) at query time.

### src/db/migrations/v30.ts
- migration v30: E2 decision first-class object (docs/plans/2026-05-28-e2-decision-object.md).

### src/db/migrations/v31.ts
- migration v31: E2 incident first-class object (docs/plans/2026-05-29-e2-incident-object.md).

### src/db/migrations/v32.ts
- migration v32: E2 process first-class object (docs/plans/2026-05-29-e2-process-object.md).

### src/db/migrations/v33.ts
- migration v33: E2 policy first-class object (docs/plans/2026-05-30-e2-policy-object.md).

### src/db/migrations/v34.ts
- migration v34: E2 skill first-class object (docs/plans/2026-05-30-e2-skill-object.md).

### src/db/migrations/v35.ts
- migration v35: E2 project_brief first-class object (docs/plans/2026-05-30-e2-project-brief-object.md).
- migration v35: All column names were checked against SQLite reserved words (skill-episode lesson re: `trigger`): repo/summary/version/status/etc. are non-reserved.

### src/db/migrations/v36.ts
- migration v36: E2 customer_note first-class object (the LAST E2 object) (docs/plans/2026-06-01-e2-customer-note-object.md).
- migration v36: (the entity-scoping dimension; a free-form account/customer id - the entities table is unbuilt E3.1, so a FK is deferred)
- migration v36: All column names checked against SQLite reserved words (skill-episode lesson, codebase-audit rule 10): customer/note/ version/status/etc. are non-reserved.

### src/db/migrations/v37.ts
- migration v37: E3.3 graph-on-consolidated guard (docs/plans/2026-06-01-e3-graph-guard.md).
- migration v37: All column names checked vs SQL reserved words (rule 10): rel_type avoids REFERENCES.

### src/db/migrations/v38.ts
- `TRG_ENTITIES_CONSOLIDATED_ONLY_INSERT`: object path (memory_id NULL): the (type,id) points at an EXISTING same-tenant E2 row whose status is active|superseded (explicit 4-way CASE per table).
- migration v38: E2-provenance: anchor graph entity/relation provenance to the authoritative E2 object (decision/policy/customer-note/project-brief) instead of the decaying memory mirror (docs/plans/2026-06-03-graph-e2-provenance.md). An in-force E2 object must STAY in the graph after its mirror memory is forgotten or consolidation-pruned.
- migration v38: object path (memory_id NULL): source_object_type/id must reference an EXISTING same-tenant E2 row whose status is active|superseded (not closed). E2 objects are consolidated BY CONSTRUCTION, so the no-raw invariant still holds.
- migration v38: source_object_id is a SOFT (type,id) pointer (no hard FK) the rebuild re-validates, so a legitimate E2 hard-delete is never blocked; a `closed` E2 row drops at next extract. SQLite cannot parametrize a table name in a trigger, so the object-path validation is an explicit 4-way CASE (one arm per E2 table).

### src/db/migrations/v39.ts
- migration v39: Memory scope isolation (docs/plans/2026-07-01-memory-scope-isolation.md).

### src/db/migrations/v40.ts
- migration v40: LC1 retrieval-trace persistence (docs/plans/2026-08-02-lc1-recall-trace-persistence.md).
- migration v40: F6 (deliberate, not an oversight): unlike v39, this migration does NOT bump `min_compatible_binary`. A pre-v40 binary opening this DB ignores the three new tables and keeps writing `last_retrieval_ids` exactly as before — it never touches `last_trace_id` (that key simply stays whatever it was). recordTraceOutcome's F4 consumer- side validation (recall-trace.ts) makes any resulting staleness harmless to linkage: it re-validates the named trace's tenant AND intersects credited ids against the trace's OWN result set before inserting, so a stale/mismatched trace id from an old-binary write gets silently skipped rather than mislinked. That preserves the plan's "drop the three tables + last_trace_id restores v39 behavior exactly" rollback promise — a min_compatible_binary bump would additionally lock old binaries out of the WHOLE store for what is purely an observability/training feature, which the rollback promise does not require.

### src/db/migrations/v41.ts
- migration v41: AT1 rejected-value tombstone (docs/plans/2026-08-15-at1-rejected-value-tombstone.md).
- migration v41: Reserved-word check on column names (skill-episode lesson, rule 10): tenant/digest/reason/rejected/source/normalized/chars are non-reserved.
- migration v41: No min_compatible_binary bump — a deliberate tradeoff (plan §2, flagged to the ship gate).

### src/db/migrations/v42.ts
- migration v42: W1 handoff envelope (trajectories/01M2BQTM4AGFVMYY7G2XV5G7WY/plan.md). Five nullable columns so the envelope carries evidence and outcome and W2/W5 can filter on them without parsing JSON.

### src/db/migrations/v45.ts
- migration v45: Token ledger (src/token-ledger.ts, ROADMAP TE0)

### src/db/migrations/v46.ts
- migration v46: CD13 failure log (src/failure-log.ts): hashes only, since failure text can carry paths and secrets.

### src/db/migrations/v47.ts
- migration v47: Scope grants (src/auth.ts, ROADMAP EI2)

### src/db/migrations/v48.ts
- migration v48: Quarantine (src/quarantine.ts, CD5)

### src/decisions.ts
- module header: E2 decision first-class object (docs/plans/2026-05-28-e2-decision-object.md).
- module header: Mirrors the v0.31 predictions pattern (src/predictions.ts).

### src/embedding-provider.ts
- module header: Design contract (see docs/plans/2026-06-08-b-pluggable-embedding-provider.md):
- module header: Local provider `id` is the BARE model string. (Historical note: this originally guaranteed NO identity change on upgrade; since the embed-text-format versioning in embeddings.ts (`embeddingIndexIdentity`, `${id}#t2`, docs/plans/2026-07-09-recall-determinism.md T1), the STORED identity carries a `#t<N>` suffix and pre-#t2 stores get exactly one forced reindex on their next embed-touching operation — deliberate, because their vectors were computed over path-contaminated text.)

### src/embeddings.ts
- `embedMemory`: L9: host-wide rebuild. The embedding index is keyed by entry.id (which is tenant-scoped) but the index itself is one per hippoRoot.
- `embedAll`: L9: host-wide by design. embedAll backfills vectors for all tenants' entries into the per-host embedding index.

### src/eval-stats.ts
- module header: Statistics and cost accounting for the token-efficiency evals (ROADMAP Part IX, TE3-TE5).

### src/extract.ts
- `storeExtractedFacts`: AT1 containment: a refusal is per-VALUE — one rejected fact must not drop the rest of this batch.

### src/failure-log.ts
- module header: Failure log (ROADMAP CD13): every failed tool call the capture-error hook sees, stored or not.
- `failuresBySession`: Rated failures per session since `sinceIso`, the input for repeat-error rate per arm (CD11, CD12).
- `FailureSummary`: Failure log totals over a window, for {@link summarizeFailures}. Counts only: a rate needs a holdout arm (CD11).

### src/forward-claim-detector.ts
- module header: J3.2 forward-claim detector — pure-function regex set + token extraction.
- module header: Iteration signal: the `recall_autodebias_hint_no_class_match` audit op (emitted by computePlanningFallacyOutput when a phrase matches but no class resolves) is the telemetry channel for deciding whether to add an embedding-based detector in J3.3.
- module header: Plan: docs/plans/2026-05-26-j32-auto-injection.md (Task 1).
- `FORWARD_CLAIM_PATTERNS`: Patterns ship-locked at v1.13.x.

### src/goals.ts
- `enforceDepthCapWithinTx`: v1.7.4 — depth-cap enforcer extracted from pushGoalWithDb and resumeGoal.
- `enforceDepthCapWithinTx`: @internal v1.7.4 -- internal goal-stack invariant. Subject to change.
- `applyGoalBoost`: A7 recall-trace side-channel: record the goal-boost step BEFORE the score is mutated, keyed by entry id. Pure read of r.score here; the mutation below is byte-identical to pre-A7.
- `applyGoalBoost`: T2 note: deliberately a PLAIN stable score sort, no compareEntryIdentity tail
- `CompleteGoalOpts`: v1.7.4 — when true, skip the strength-multiplier propagation block.

### src/graph-extract.ts
- module header: E3.1 deterministic entity extraction (first slice) (docs/plans/2026-06-01-e3-deterministic-extraction.md).
- module header: Populates the E3 graph from the already-structured consolidated E2-object tables
- module header: Pass 3 (E3 cross-object, docs/plans/2026-06-02-e3-cross-object-references.md) adds the first CROSS-OBJECT relations
- module-wide: comments called the first-class object tables (decisions / policies / customer_notes / project_briefs) by their roadmap code E2: "E2 row", "E2 table id", "E2 id", "E2-derived", "E2 table", "E2 source-object ref", "E2 object", "E2 row shapes", "E2 source object", "consolidated E2 objects", "current E2 state", "authoritative E2 object", "E2 name fields", "E2 save APIs".

### src/graph-recall.ts
- module header: E3.2 multi-hop graph recall (docs/plans/2026-06-02-e3.2-multihop-recall.md).
- module header: READ-ONLY consumer of the E3 graph substrate (entities/relations built by E3.1, guarded by E3.3).
- module header: the moment E3.1 emits cross-object edges (owns/depends-on/blocked-by/references) the SAME traversal lights up cross-entity multi-hop with zero rework here.
- module header: Design points (the first two were forced by the verify-stage benchmark, the rest by codex review — all root-cause, not patches):
- module header: No graph writes (only SELECTs via graph.ts read helpers + store reads), so the E3.3 check-graph-writes lint permits this module living outside graph.ts.
- `graphExpandRecall`: compareEntryIdentity is only the TAIL for a same-hop, same-score tie (T2, deterministic tie keys).
- `graphExpandRecall`: T2 note: PLAIN stable score sort on purpose -- both input lists are deterministically ordered by this point, stability inherits that, and a base-vs-graph-hit tie keeps the BASE result first (the concat order), preserving pre-T2 semantics.

### src/graph-stream.ts
- `module header`: L1 — graph-retrieval ranked-list stream for RRF fusion (docs/plans/2026-06-02-l1-graph-rrf-stream.md).
- `module header`: READ-ONLY consumer of the E3 graph substrate (entities/relations built by E3.1, guarded by E3.3).
- `module header`: Reuses the E3.2 BFS traversal shape from graph-recall.ts ... Pure reads (SELECTs only via graph.ts helpers), so the E3.3 check-graph-writes lint permits this module living outside graph.ts.

### src/graph-view.ts
- `module header`: E3 graph observability + visualization — READ-ONLY over the entity/relation graph (docs/plans/2026-06-02-graph-observability.md).

### src/graph/read.ts
- `multi-hop read helpers section`: E3.2 multi-hop recall read helpers (SELECT-only; the check-graph-writes lint permits these here and in the read-only consumer src/graph-recall.ts).
- `loadEntitiesByMemoryId`: Map consolidated source memory ids -> their graph entities. The SEED step of E3.2 multi-hop recall (recall result memory ids -> entities to traverse from).
- `loadNeighborRelations`: All relations touching ANY of `entityIds` in EITHER direction (from OR to) — the per-hop neighbour query for E3.2 multi-hop traversal.
- `loadNeighborRelations`: `limit` is applied PER CHUNK; a frontier spanning >IN_LIST_CHUNK ids could return up to limit*chunks rows before the by-id dedup below. Harmless for E3.2 (the frontier is bounded by maxNeighbors <= 200 << IN_LIST_CHUNK, so a single chunk, and the BFS re-enforces the per-hop fanout cap)

### src/graph/types.ts
- `SourceObjectType`: The authoritative E2 object types a graph row may be anchored to (the object provenance path, alongside the memory path).
- `SourceObjectRef`: A soft (type,id) pointer to the authoritative E2 row a graph row descends from.
- `Entity.sourceObjectType`: The authoritative E2 object this entity is anchored to (E2-provenance path). Set for E2-sourced entities; absent for memory-only (prose/NLP) entities.
- `InsertEntityOpts`: NULL/omitted when the entity is anchored only to its E2 source object (mirror forgotten/pruned). / The authoritative E2 object this entity descends from.
- `InsertRelationOpts`: NULL/omitted when the relation is anchored only to its E2 source object. / The authoritative E2 object this relation descends from.

### src/graph/write.ts
- `module header`: E3.3 graph layer over consolidated state - the graph-on-consolidated guard. (docs/plans/2026-06-01-e3-graph-guard.md).
- `module header`: Scope (E3.3 first slice): the substrate + the guard + a thin insert/load/enqueue API. The `graph_extraction_queue` is the interface the deferred `hippo sleep` enqueue-hook + E3.1 entity extraction will call. No operator surface (CLI/HTTP/SDK) until E3.2 multi-hop recall.
- `SourceObjectTableMap`: source_object_type -> its E2 table, for the object-path validation 4-way branch.
- `resolveConsolidatedSource`: OBJECT path (`memoryId` null, `sourceObject` set): the E2 row must exist, be same-tenant, and have status active|superseded (4-way per E2 table). E2 objects are consolidated BY CONSTRUCTION, so this returns 'distilled'.
- `resolveConsolidatedSource`: graph-extract reads E2 rows then inserts ... (v38 contract; codex round-4 race).
- `resolveConsolidatedSource`: source_kind is the memory's kind when a memory is present, else 'distilled' for an object-only row (E2 objects are consolidated by construction).
- `extraction queue section`: Extraction queue (the interface the deferred sleep enqueue-hook + E3.1 will use)
- `enqueueExtraction`: The producer hook in `hippo sleep` is deferred (E3.1); this is the API it will call.
- `clearGraph`: Lives in graph.ts (the sole sanctioned graph writer), so the E3.3 CI lint permits this `DELETE FROM entities`.
- `sleep enqueue-hook section`: E3 sleep enqueue-hook — producer helper + drain support
- `markGraphDirty`: NEVER throws into the caller — a graph-dirty signal failing must not abort a core E2 write. ... Called POST-COMMIT from the E2 graph-source save/close mutations of decision, policy, customer_note and project_brief. / swallowed so the already-committed E2 write is never rolled back.
- `removeGraphEntitiesForObject`: Remove the graph rows sourced from one E2 object, by its (type, id). ... Fail-soft like `markGraphDirty` (never throws into the E2 close caller; graph staleness is recoverable).

### src/half-life-migration.ts
- `module header`: without this migration a store would mix old-base and new-base memories, a state the decay evaluation never tested (docs/evals/2026-09-24-decay-default-prereg.md, Migration). The rule, declared there before any run:
- `conflictLosers`: A resolved conflict with no audit row (before v1.31.0, or found stale) names no winner, so both sides count.

### src/hooks/json-hooks.ts
- `hasLegacySplitSessionEnd`: Returns true when `hooks.SessionEnd` still contains either of the legacy v0.22.x split entries (bare `hippo sleep` / `hippo capture --last-session`) without the current consolidated `hippo session-end` entry.

### src/incidents.ts
- `module header`: E2 incident first-class object (docs/plans/2026-05-29-e2-incident-object.md).

### src/instruction-detect.ts
- `module header`: Prompt-injection detection for untrusted memory content (CD5).

### src/mcp/admin-tools.ts
- `runPredictBaserateTool`: J3 reference-class / planning-fallacy detector. Reads from the E2 predictions table; returns text-only response matching the existing MCP tool convention (no structured JSON over the wire). Direct call to computePredictionBaserate; helper opens its own db + emits audit (single source of truth, no caller-site drift).
- `runResolveTool`: AT1: optional rejectLoser + reason, threaded straight through to resolveConflict's opts (plan §5 — mirrors the CLI's --reject-loser).
- `runPeersTool`: D4 v1.12.10: tenant-scope the cross-project peer discovery. tenantId is the caller's tenant (matches hippo_share above); passing undefined would restore the pre-D4 host-wide behaviour.

### src/mcp/format.ts
- `planningSection`: J3.2: the hint depends on the query alone, so api.retrieve's copy is the one shown; JSON.stringify fences the phrase.

### src/mcp/protocol.ts
- `McpContext.scopes`: EI2: scope grants for the HTTP-MCP caller's key.

### src/mcp/recall-tools.ts
- `runRecallTool render`: J1, J2 and C5: the hints and Cutoff block describe the list MCP shows, not the window band in apiResult.

### src/mcp/request.ts
- `token ledger section`: ── Token ledger (ROADMAP TE0) ──
- `callTool tenantId`: A5: every store read in this server returns to the caller and is tenant-isolated.

### src/mcp/session-state.ts
- `sessionRecallHistoryMcp`: v0.33 / J1 — Module-level per-(tenant, session) recall-history ring map for the MCP pipeline. Separate from CLI/HTTP rings per plan v3 architecture (per-pipeline rings; no IPC).

### src/memory-value-weights.ts
- `module header`: LC2-E2 frozen learned memory-value weight vector. GENERATED FROM the E2 frozen artifact
- `module header`: CAVEAT (verbatim from the E2 result doc, carried by design decision D3 / binding constraint 4 in docs/plans/2026-08-10-lc2-e3-mv-wiring.md): usage-feature signs reflect E1's anti-oracle simulation, NOT real usage value. Never read this as production ranking advice — LC3 tests real usage value.
- `MEMORY_VALUE_WEIGHTS`: The 8 live feature dims the E2 fitter optimized over (FIT_DIMS).

### src/memory-value.ts
- `module header`: LC2-E3 — learned memory-value scorer, wired into the sleep decay pass as a rescue-only veto (design D1/D2, docs/plans/2026-08-10-lc2-e3-mv-wiring.md).
- `module header`: computeMvFeatures mirrors benchmarks/memory-value/extract.mjs's computeFeatures for the 8 live dims the E2 fitter optimized over (FIT_DIMS)
- `module header`: rescueSet implements D1's rescue-only semantics: a condemned entry is rescued iff its learned score ranks in the top 30% (RESCUE_BUDGET, the E2 keep-budget operating point) of its own tenant's non-pinned candidate set (D2).
- `RESCUE_BUDGET`: The E2 keep-budget operating point (the only point with measured evidence) — a code constant tied to that evidence, not user-tunable.
- `scoreEntries`: The normalization context is exactly the entries passed in — callers control the bounded scope (D2: per-tenant, non-pinned).
- `MvRankInfo.totalNonPinned`: Size of the tenant's non-pinned candidate set (D2).
- `rankNonPinnedByTenant`: Groups non-pinned entries by tenantId (D2), scores + ranks each tenant's group independently
- `rankNonPinnedByTenant`: if (e.pinned) continue; // D2: pinned entries never compete for rescue (never condemned)
- `rescueSet`: D1 rescue decision: a condemned entry is rescued iff it ranks in the top 30% of its tenant's non-pinned candidate set by learned score.
- `rescueSet`: validateWeights(weights, digest); // fail loud before any rescue computation (constraint 5)

### src/memory.ts
- `MemoryEntry`: semantic gain. F4 (v1.6.5) uses byte compare on `assemble`; if a future import path admits non-canonical timestamps, the F4 sort and any
- `MemoryEntry`: Cached DAG metadata (schema v25). Populated for level-2+ summary rows so
- `MemoryEntry`: DAG live-coupling (schema v28, E1 of 5-episode arc).
- `MemoryEntry`: v28: 1 when this summary row has at least one child invalidated, ... by E3's rebuildDirtySummaries during sleep. Always 0 for non-summary rows (dag_level !== 2; E5 widens to include 3).
- `MemoryEntry`: v28: ISO 8601 timestamp of the last successful rebuild for this
- `MemoryEntry`: v28: monotonically-increasing counter of successful rebuilds for this summary. 0 for initial buildDag write; bumped by E3.
- `MemoryEntry`: v28 (reserved for E5): ISO 8601 timestamp the level-3 entity profile
- `MemoryEntry`: A3 provenance envelope (schema v14)
- `MemoryEntry`: A5 stub auth (schema v16)
- `MemoryEntry`: Memory scope isolation (schema v39): owning project for ambient-context ... everywhere), or null for legacy pre-v39 rows - ambient context treats null as other-project (deny). Stamped from the store's location at write time (store.ts stampOriginProject); undefined only on entries not yet written. See docs/plans/2026-07-01-memory-scope-isolation.md.
- `MemoryEntry`: F1 (v1.7.0): raw SQLite FTS5 bm25() score from the FTS path of
- `CHURN_STALE_TAG`: FE2: tag on a memory whose named file/symbol/script changed after it was stored.
- `EMOTIONAL_MULTIPLIERS`: Emotional multipliers from PLAN.md. v1.13.5 / J5 loss-aversion calibration (Lovallo-Kahneman TFAS empirics: losses ~2x larger than equivalent gains). Defaults rebalanced: - positive (success-tagged): 1.3 -> 1.0 - negative (error-tagged): 1.5 -> 2.0 - critical stays at 2.0 (literal roadmap reading; J5 silent on critical; ranking signal in consolidate.ts/salience.ts/ambient.ts unchanged) - neutral stays at 1.0
- `getLossAversionRatio`: v1.13.5 / J5 — module-level lazy-cached read of HIPPO_LOSS_AVERSION_RATIO.
- `LOSS_AVERSION_RATIO_MIN`: v1.13.5 minimum acceptable ratio. Below this, the negative multiplier ... cycle. 0.5 is chosen as the floor because (a) it recovers the v1.13.4 ... the v1.13.4 default), and (b) below this the user is asking for LESS
- `getLossAversionRatio`: Floor at the v1.13.4-equivalent (0.5) so the env var's tuning
- `getLossAversionRatio`: Users wanting LESS loss aversion than v1.13.4's 1.5 multiplier should reconsider the design intent of J5 (the calibration was
- `getLossAversionRatio`: `HIPPO_NEGATIVE_MULTIPLIER` env override (deferred to J5-v2).
- `emotionalMultiplier`: `critical` is deliberately NOT scaled: J5 roadmap is silent on critical; its multiplier is left alone so the calibration only touches the
- `calculateStrength`: clock: wall-clock time (default pre-v0.15)
- `calculateStrength`: adaptive: auto-scale half-life by session frequency (default v0.15+)
- `calculateStrength`: Retrieval boost: 1 + 0.1 * log2(retrieval_count + 1)
- `calculateStrength`: Emotional multiplier. v1.13.5 / J5: apply HIPPO_LOSS_AVERSION_RATIO to the negative multiplier ONLY (positive/critical/neutral pass through unchanged). Lazy module-cache means this is a single Map lookup + one numeric multiply, not a per-call process.env read.
- `DEFAULT_HALF_LIFE_DAYS`: write-time multipliers. 365 since 1.46.0: the pre-registered E1 decision (docs/evals/2026-09-24-decay-default-result.md and prereg-2) found 7 days lost the current fact far more often (29% vs 75% in the top five), and 730 days and decay off tied with 365. `hippo sleep` moves memories still

### src/multihop.ts
- `multihopSearch`: T2 note: PLAIN stable score sort on purpose -- pass1/pass2 inputs are deterministically ordered (search() carries the content tail), stability inherits that, and ties keep pass-1 results ahead of pass-2 follow-ups.

### src/owner-validation.ts
- `module header`: --owner format validation (B2 v1.12.6).
- `module header`: with id ∈ `[A-Za-z0-9_-]+`. Pre-v1.12.6 any string was accepted, leaving the documented contract unenforced.
- `module header`: to reject + exit. Strict mode will become the default once A5 v2 lands (see `TODOS.md` A3 follow-ups for the migration path).

### src/physics.ts
- `queryGravity`: F1: Query gravity (retrieval-time, virtual — does not update position).
- `attractionForce`: F2: Inter-memory attraction force vector (consolidation-time).
- `repulsionForce`: F3: Conflict repulsion force vector (consolidation-time).
- `dragForce`: F4: Drag force vector (consolidation-time).

### src/policies.ts
- `module header`: E2 policy first-class object (docs/plans/2026-05-30-e2-policy-object.md).
- `loadActivePolicies`: Date-only `asOfDate` (e.g. "2026-05-30", no time component) resolves to the END

### src/predictions/planning-fallacy.ts
- `module section`: J3.2 — auto-injection of reference-class baserate on recall
- `PlanningFallacyHint`: J3.2 surface delivered on `RecallResult.planningFallacyHint` when an
- `PlanningFallacyHint`: Plan: docs/plans/2026-05-26-j32-auto-injection.md.
- `PlanningFallacyOutput`: v1.13.4 / J3.2 follow-up — richer return type for
- `computePlanningFallacyOutput`: J3.2 orchestrator.
- `computePlanningFallacyOutput`: Returns `{ watching: ... }` on (v1.13.4 NEW — was silent null pre-1.13.4):
- `computePlanningFallacyOutput`: Latency budget (plan §Latency): ~50us regex-only on miss; ~750-850us on full match+resolve+baserate path. Well under 50ms target.
- `computePlanningFallacyOutput`: Telemetry: forward-claim detected, ≥2 classes tied at best overlap. v1.13.4: now ALSO returns a watching variant so the caller surface can render a "watching but no baserate (tiebreak)" line. Audit emission unchanged (the audit channel is the telemetry-grade source of truth).
- `computePlanningFallacyOutput`: Telemetry: forward-claim detected, no class scored ≥ 1. This is the channel that drives the embedding-fallback decision for J3.3 — high volume here = regex+token-overlap is missing legitimate forward-claims that have NO obvious class signal. v1.13.4: now ALSO returns a watching variant so the caller surface can render a "watching but no baserate (no class match)" line.

### src/predictions/store.ts
- `module header`: E2 prediction first-class object (v0.31 / docs/plans/2026-05-26-e2-prediction-object.md).
- `module header`: J3 (reference-class / planning-fallacy detector) reads from `loadPredictionsByClass` to compute per-class base rates from (estimate_value, actual_value) at query time. J3 is a follow-up episode; this module ships the data layer.
- `savePrediction`: the predictions table is the canonical structured store used by J3.
- `closePrediction`: J3 computes accuracy (clean vs regressed) from (estimateValue, actualValue) at query time.
- `section header`: v0.31 / J3 — reference-class / planning-fallacy detector
- `computePredictionBaserate`: Used by J3 reference-class / planning-fallacy detector.
- `computePredictionBaserate.emitAudit`: v0.32 / J3.2 — when false, skip the predict_baserate audit emit. The J3.2 orchestrator (computePlanningFallacyOutput, below) calls this with emitAudit=false and emits its own `recall_autodebias_hint` audit row instead, so the predict_baserate channel stays scoped to deliberate CLI / HTTP / MCP predict-baserate calls and does NOT pollute on every recall containing a forward-claim phrase. Default true preserves the v1.13.0 J3 audit semantics for the 3 direct callers (cmdPredict baserate, /v1/predictions/stats route, hippo_predict_baserate MCP handler) — none of them pass this argument.
- `computePredictionBaserate`: Skipped when emitAudit=false (J3.2 orchestrator path; its own recall_autodebias_hint audit fires only when nClosed > 0 anyway, so no signal is lost).

### src/processes.ts
- `module header`: E2 process first-class object (docs/plans/2026-05-29-e2-process-object.md).

### src/project-briefs.ts
- `module header`: E2 project_brief first-class object (docs/plans/2026-05-30-e2-project-brief-object.md).
- `loadActiveBriefForRepo`: if an operator created more than one (the DB does not prevent it, consistent with every other E2 object), the MOST-RECENT active row wins.

### src/project-identity.ts
- `module header`: Project identity resolution for memory scope isolation (ROADMAP.md Part I [Committed] "Memory scope isolation"; plan docs/plans/2026-07-01-memory-scope-isolation.md S1).
- `findHippoStoreDir`: Design notes: docs/plans/2026-09-05-*.md
- `deriveOriginProject`: a NULL origin_project column is reserved for legacy pre-migration rows, which ambient context treats as deny (see plan docs/plans/2026-07-01-memory-scope-isolation.md "Origin model").

### src/prompt-recall.ts
- `module header`: Z1: recall gated on the hook prompt, not the five newest memories (pure, no I/O). See docs/plans/2026-09-26-z1-prompt-recall.md.

### src/rate-limit.ts
- `module header`: Bounds api-key-id enumeration (the v0.40 follow-up noted in auth.ts)

### src/raw-archive.ts
- `moveRowToArchive`: GDPR Path A (v0.39): raw_archive stores ONLY metadata, not the original memory content.
- `auditArchive`: A5 audit: emit archive_raw event inside the SAVEPOINT so the audit row is committed atomically with the row deletion.
- `archiveRawMemory`: v0.30 / E2 — DAG live-coupling: archive of a child under a level-2 summary marks parent dirty. Inside the SAVEPOINT so the dirty-mark commits atomically with the archive. row.dag_parent_id was fetched via SELECT * at L28 (schema v28 includes it).
- `archiveRawMemory`: afterArchive hook (v0.39 commit 3): connector-level idempotency markers (e.g. slack_event_log) must commit atomically with the archive itself.

### src/recall-history.ts
- `module header`: J1 anchoring detector (recall-recurrence) — pure module. Implements two detection rules from ROADMAP-RESEARCH.md L546: R1 query_repeat ... R2 memory_dominance ...
- `module header`: Per the plan v3 architectural decision: each pipeline (api.recall via HTTP, cmdRecall, MCP hippo_recall) owns its OWN ring buffer Map keyed by (tenant, session).
- `module header`: Plan: docs/plans/2026-05-26-j1-anchoring-detector.md. Composes with J3.2: AnchoringHint + PlanningFallacyHint are independent signals; both can fire on the same recall.
- `RecallHistoryEntry` / `DetectAnchoringOpts` / `detectAnchoring`: rule labels R1 (query_repeat) and R2 (memory_dominance) renamed to their reason strings in comments.
- `hashQueryText`: Token sort + dedup means semantically-equivalent queries with reordered words collide intentionally (the roadmap's "semantically-distinct" v1 uses textual normalization; embedding-based distinctness is J1-v2).

### src/recall-scope.ts
- `module header`: v1.25.0 — recall-side scope predicates, extracted from api.ts into a leaf module so shared.ts (which api.ts imports) can apply the same default-deny rule to searchBothHybrid's internal candidate loads without an import cycle. Mirrors the v39 `project-identity.ts` precedent.
- `isPrivateScope`: v1.2.1: source-agnostic private-scope detector.
- `passesScopeFilterForRecall`: @internal v1.7.2 — exported for test parity with `RECALL_DEFAULT_DENY_SCOPES` (single-source-of-truth verification).
- `passesCliRecallScopeFilter`: v1.25.0 — the CLI `--scope` variant of the recall filter (JS half of the SQL 'default-deny-or-exact' mode in loadSearchRows).
- `assertScopeRequestAllowed`: Authorize an explicitly requested scope before any read honours it (ROADMAP Part VIII EI2: member scope grants).

### src/recall-trace.ts
- `module header`: LC1 — retrieval-trace persistence (docs/plans/2026-08-02-lc1-recall-trace-persistence.md).
- `writeRecallTraceAtRoot`: NOT used by api.recall, which must reuse the caller's open handle (v1.11.5 no-side-effects contract, tests/api-recall-no-side-effects.test.ts).

### src/refine-llm.ts
- `RefineOptions.tenantId`: L9: tenant scope.
- `refineStore`: L9: when opts.tenantId is provided, scope the top-level scan to this tenant's consolidated entries.
- `refineStore`: L9: parent lookup scoped by opts.tenantId when provided.

### src/reject-flow.ts
- `module header`: AT1 rejected-value tombstone — shared reject/unreject/list flow. docs/plans/2026-08-15-at1-rejected-value-tombstone.md (T2, plan §4).
- `RejectFlowResult.content`: The rejected content, for the CLI's at-reject-time echo (plan §2: the tombstone itself stores no content — this is the only place it's seen again after this call returns).

### src/rejection.ts
- `module header`: AT1 rejected-value tombstone — core invariant. docs/plans/2026-08-15-at1-rejected-value-tombstone.md
- `insertRejectedValue`: used by the T2 `reject` verb and `resolveConflict`'s `rejectLoserValue` path.
- `deleteRejectedValue`: Delete a tombstone by tenant + exact digest — the T2 `unreject` verb, the only v1 escape hatch (plan §4).
- `listRejectedValues`: List tombstones for a tenant, newest first — the T2 `rejections` verb.

### src/rerankers/jev.ts
- `DEFAULT_MODEL`: Pinned, not `jev-latest`: every number in docs/evals/2026-09-19-jev-reranker.md was measured on this version, and the alias moves whenever the vendor ships a release.
- `JEV_DEFAULT_TOP_K`: The pool size every number in docs/evals/2026-09-19-jev-reranker.md was measured at.
- `jevReranker`: Cost, env vars, evidence and limits: docs/evals/2026-09-19-jev-reranker.md.

### src/rerankers/llm.ts
- `module header`: Skeleton only — see docs/plans/2026-05-10-f6-reranker-hardening.md Task 8. Full characterisation deferred to a follow-on plan.

### src/rerankers/types.ts
- `RerankerFn`: Determinism is required for paired A/B and for the workload-validity gate in docs/evals/2026-05-10-f6-reranker-prereg.md.

### src/rrf.ts
- `module header`: the value already in use across hippo's `hybridSearch` since v1.0.
- `module header`: Generic over the candidate id type so this helper can be shared by `src/search.ts::hybridSearch` (T = number, idx into MemoryEntry[]) and the LongMemEval F9 hybrid retrieve benchmark (T = string, session_id).

### src/secret-detect.ts
- `module header`: Secret detection for memory content (v39 memory scope isolation, S4; docs/plans/2026-07-01-memory-scope-isolation.md).
- `module header`: This is deliberately a thin slice of the A4 lifecycle-compliance item (no PII detection).
- `redactSecrets`: e.g. the CS1 pre-compact snapshot fields — can scrub it in place instead.

### src/server.ts
- `handleRequest`: v1.6.4: pre-decode raw-URL slash check.
- `assertNoLiveServer`: H3: refuse to start if a live hippo server already serves this hippoRoot.
- `bootRateLimiter`: E3: per-IP rate limiter for /v1/* and /mcp*.
- `replyWithFailure`: M3: readBody hit the 1 MB cap mid-stream, so drop the socket rather than drain unbounded bytes.
- `serve`: Refuses non-loopback hosts at boot (Footgun #3 from the A1 plan) unless HIPPO_REQUIRE_AUTH=1 is set. The A5 v2 auth middleware (buildContextWithAuth / requireAuth) has shipped and every route checks it
- `serve.stop`: an unconditional unlink here would orphan it. (v0.37.0 server-hardening.)

### src/server/auth.ts
- `buildContextWithAuth`: v1.12.0: loopback fallback is process-local, treat as admin.

### src/server/client-ip.ts
- `enforceRateLimit`: E3: per-IP rate limit on /v1/* and /mcp* to bound api-key-id enumeration.

### src/server/mcp-http.ts
- `section header`: ── MCP-over-HTTP/SSE transport (Task 11) ──
- `handleMcpPost`: v1.12.0: McpContext.actor stays string; extract subject at the boundary.
- `handleMcpStream`: v0.39 SSE hardening:

### src/server/routes/admin.ts
- `handleCreateAuthKey`: POST /v1/auth/keys — mint a new API key. Plaintext lands in the response body (Task 8)
- `handleCreateAuthKey`: v1.12.3: optional body.role mirrors the --role CLI flag.
- `handleListQuarantine`: GET /v1/quarantine?status=&limit=&cursor=: CD5 review queue.

### src/server/routes/customer-notes.ts
- `section header`: ── E2 customer_note routes ──

### src/server/routes/decisions.ts
- `section header`: ── decisions (E2 first-class object) ──
- `handleCreateDecision`: DoS caps: text 4096, context 4096 (v1.11.4 pattern).

### src/server/routes/incidents.ts
- `section header`: ── incidents (E2 first-class object) ──
- `handleCreateIncident`: DoS caps: text 4096, context 4096, resolutionText 4096 (v1.11.4 pattern).

### src/server/routes/memories.ts
- `handleApplyOutcome`: v1.11.5: DoS cap on ids.length.
- `handleSleep`: v1.12.0 A5 v2 sub-1: admin-role gate. Forward-defensive — exists today under loopback-only enforcement
- `handleSleep`: v1.12.0: sleepCtx already built above for the admin-role gate; reuse.

### src/server/routes/policies.ts
- `section header`: ── policies (E2 first-class object, bi-temporal-first) ──

### src/server/routes/predictions.ts
- `section header`: ── E2 prediction first-class object (v0.31) ── docs/plans/2026-05-26-e2-prediction-object.md
- `handleCreatePrediction`: DoS caps on claim (4096 chars) + closureNote (2048 chars) per v1.11.4 pattern.
- `handlePredictionStats`: J3 reference-class / planning-fallacy detector (v0.31).

### src/server/routes/processes.ts
- `section header`: ── processes (E2 first-class object) ──

### src/server/routes/project-briefs.ts
- `section header`: ── E2 project_brief routes ──

### src/server/routes/recall.ts
- `sessionRecallHistoryHttp`: v0.33 / J1 — Module-level per-(tenant, session) recall-history ring map for the HTTP pipeline. Separate from CLI/MCP rings per plan v3 (per-pipeline rings; no IPC).
- `parseFreshTail`: v1.6.2: surface the v1.5.0/v1.5.2 RecallOpts additions to HTTP callers.
- `parseSessionId`: v1.7.4: session_id for the dlPFC goal-stack boost.
- `parseRecallQuery`: A7 recall-trace: opt-in explain flag.
- `snapshotSessionRing`: v0.33 / J1 — HTTP per-pipeline anchoring detector.
- `handleRecallMemories`: v0.33 / J1 — append AFTER recall completes (snapshot was taken before recall() ran).
- `handleDrillRecall`: v0.30 / E5: depth query param walks N levels (default 1, hard cap 10).
- `handleDrillRecall`: L4 fold: reject out-of-range explicitly (no silent clamp).
- `handleDrillRecall`: v1.6.4: leaf id maps to 422 (caller-actionable).
- `handleGetContext`: v1.11.5: DoS cap on q-param length.

### src/server/routes/skills.ts
- `section header`: ── skills (E2 first-class object, executable/exportable) ──

### src/server/types.ts
- `ServerHandle.server`: Introspection-only (v1.26.2): the underlying node:http Server, exposed so tests can assert keep-alive/headers timeout hardening without reaching into serve()'s closure.

### src/server/validation.ts
- `parseListLimit`: Parse a `?limit=` query param for the E2 list routes. Defaults to 100; requires a positive INTEGER <= 1000. Number.isInteger rejects fractional values like "1.5" that Number.isFinite would pass but SQLite `LIMIT ?` rejects with a datatype mismatch (a 500).
- `validateIdSegment`: v1.6.4: charset + length validation for `:id` route captures.

### src/shared.ts
- `promoteToGlobal`: CD5: same veto as shareMemory; a promoted copy would have no quarantine record to review.
- `searchBoth`: T2 note: PLAIN stable score sort on purpose -- local/global inputs are each deterministically ordered (content tail applied in the underlying search), stability inherits that, and an exact post-bump tie keeps the LOCAL result ahead of the global one (the concat order), preserving the pre-T2 semantics.
- `HybridSearchOptions.summaryDeboost`: v0.30 / E4 — propagated to underlying hybridSearch calls.
- `HybridSearchOptions.summaryFreshness`: v0.30 / E4 — propagated.
- `HybridSearchOptions.recallScope`: v1.25.0 — recall-mode scope filter, consumed by `searchBothHybrid` only.
- `searchBothHybrid`: v1.25.0 recall mode: push the scope predicate into SQL exactly like api.recall (loadRecallSearchEntries)
- `rankBothStores`: T2 note: PLAIN stable score sort on purpose -- see searchBoth above; same rationale (deterministic inputs + stability; local-first on ties).
- `shareMemory`: v39 S4 producer veto: secrets never go to the global store, not even with --force.
- `shareMemory`: CD5: a quarantined row is unreviewed input, not a lesson; sharing it would spread poison globally.
- `listPeers`: D4 v1.12.10: `tenantId` is now optional.
- `listPeers`: D4: tenant-scoped by default when tenantId provided. Host-wide when undefined (preserves back-compat).
- `isAutoShareCandidate`: CD5: shareMemory refuses quarantined rows; filtering here keeps sleep from aborting on one.
- `isAutoShareCandidate`: v39 S4 producer veto: secret rows never auto-share, regardless of transfer score. ... Checked LAST (v1.25.0) so the stats counter only counts rows the veto actually withheld
- `shareCandidates`: AT1 containment (docs/plans/2026-08-15-at1-rejected-value-tombstone.md plan §3 — sync/promote/share copy paths must not let ONE rejected candidate kill the batch)
- `shareCandidates`: writeEntry's own catch already writes the reject_refusal audit before rethrowing (plan §3) — do not double-audit here, just count and continue.
- `autoShare`: L9: `options.tenantId` is opt-in.
- `autoShare`: The only intentional unscoped internal caller as of v1.12.1 is `api.sleep` (`src/api.ts:2041`), which passes options without tenantId because `sleep` is host-wide by intent; see `src/api.ts:2073-2077` for the cross-tenant dedup rationale.
- `autoShare`: v1.25.0: `options.stats` is an opt-in out-param.
- `autoShare`: AT1: `stats.rejectedSkipped` (optional) is incremented once per candidate refused by the GLOBAL store's rejection tombstone
- `autoShare`: L9: host-wide read. The global store IS the union across all tenants; per-tenant filtering on the global root would defeat the purpose.
- `syncGlobalToLocal`: L9: host-wide read. syncGlobalToLocal copies the global union into a tenant-scoped local store

### src/skills.ts
- `skills.ts` (module header): E2 skill first-class object (docs/plans/2026-05-30-e2-skill-object.md).

### src/store/audit-event.ts
- `auditRejectionRefusal`: Refusal audit for the AT1 rejection guard (plan §3).

### src/store/candidates.ts
- `loadAmbientCandidates`: One connection; `recall` piggybacks the Z1 FTS query on it too.

### src/store/delete-and-batch.ts
- `deleteEntryCore`: AT1 (plan §4, round-2 fix, designed from source): db-scoped delete core. `deleteEntry` used to open+close its OWN connection, which meant it could never compose inside a caller's transaction (unlike writeEntry/ writeEntryDbOnly, which already split this way). Split identically: row- meta SELECT, `DELETE FROM memories`, FTS delete, `forget` audit, DAG dirty-mark. NO filesystem I/O — the caller's own transaction may still be rolled back, and mirror writes must only happen post-commit.
- `deleteEntryCore`: `opts.suppressForgetAudit` (default false, off): two AT1 callers set this so a removed non-raw row does NOT ALSO emit a `forget` row, because each already writes its own aggregate audit trail — `src/reject-flow.ts`'s `rejectValue` (single `reject_value` row covering every same-digest row removed) and `resolveConflict` (`conflict_resolve` row per resolution). Default keeps `deleteEntry` byte-identical to its pre-split behavior.
- `deleteEntryCore`: v0.30 / E2 — DAG live-coupling: forget of a child under a level-2 summary marks parent dirty. Non-atomic with the DELETE (no SAVEPOINT wrapper here, same as pre-split deleteEntry); markSummaryDirtyInTx is idempotent so any future child mutation re-marks parent if this fails. Acceptable degradation, mirrors the pre-split audit best-effort posture.
- `batchWriteAndDelete`: v0.30 / E2 — DAG live-coupling: BEFORE deletes, snapshot dag_parent_id for every doomed row so we can mark parents dirty post-COMMIT. Done inside the same BEGIN so the SELECT sees pre-delete state.
- `applyBatchWrites`: AT1 (plan §3, corrected): bypass the rejection guard here. Consolidation merges are DETERMINISTIC CONCATENATION (mergeContents, consolidate.ts:736-751) of already-guarded leaf facts, not an LLM paraphrase — refusing mid-batch would abort the whole consolidation transaction. The bypass is safe because consolidate.ts's merge pass now checks the merged content's rejection digest against the tenant's tombstones BEFORE ever pushing a merge into pendingWrites, skipping that merge entirely on a hit, AND because the point-probe immediately above closes the race window between that producer check and this COMMIT. The guard itself still belongs on leaf inserts, which write through writeEntry / writeEntryDbOnly and stay guarded (bypassRejectionGuard defaults false).

### src/store/entry-reads.ts
- `loadEntriesByIds`: Used by DAG-aware recall (docs/plans/2026-05-05-dag-recall.md Task 1.5) to fetch parent summaries for a set of overflowed leaves.
- `loadEntriesByIds`: T2: no ORDER BY meant row order followed SQLite's IN(...) scan order (undefined w.r.t. the caller's `ids` order). created ASC, id ASC makes it deterministic.
- `loadFreshRawMemories`: Deprecation note (v1.6.5) — the **tenant-wide call shape** (omitting `sessionId`) is rarely the right shape for "what did I just see in this conversation". `api.recall` enforces session scoping when `HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL=1` is set, throwing `RecallContractError` instead. Tenant-wide remains the back-compat default but is discouraged for new callers. Passing `sessionId` is fully supported and recommended; this function is NOT deprecated as a whole.
- `loadChildrenOf`: Used by `drillDown` (Task 3).

### src/store/entry-row.ts
- `upsertEntryRow`: `bypassRejectionGuard` (AT1, plan §3): ONLY `batchWriteAndDelete`'s call site passes `true`. Consolidation merges are DETERMINISTIC CONCATENATION (mergeContents, consolidate.ts:736-751), not LLM paraphrase — the bypass is safe because the producer (consolidate.ts's merge pass) now checks the merged content's rejection digest against the tenant's tombstones BEFORE ever assembling a batch to write, and skips the merge entirely on a hit. Every other caller (writeEntryDbOnly, bootstrapLegacyStore, rebuildIndex) leaves this false and the guard runs live.
- `writeEntry` (stray doc above stampOriginProject): The HTTP server (A1) and api.* layer pass the resolved actor (`api_key:<key_id>` / `localhost:cli`) so audit events land with one row per write, no double-emit.
- `writeEntry` (stray doc above stampOriginProject): Used by E1.3+ connectors to stamp idempotency rows atomically with the memory write.

### src/store/entry-writes.ts
- `writeEntry`: AT1 (plan §3): writeEntryDbOnly's own SAVEPOINT has already unwound by the time this catch runs, so the refusal audit lands post-rollback in a fresh implicit transaction — then rethrow so the caller sees the refusal.
- `writeEntryDbOnly`: v0.30 / E2 — DAG live-coupling: child write under a level-2 summary marks the parent dirty for E3 sleep-cycle rebuild. Early-exit on null dag_parent_id (vast majority of writes); cost is one null check on the hot path.

### src/store/handoffs.ts
- `HANDOFF_COLUMNS`: W1: the nine-column SELECT was cloned four times (plan rule 8); one definition so a sixth caller can't drift from the other five.
- `saveSessionHandoff`: v1.2: scope is wired through. Read-side default-deny in api.recall + cmdRecall continuity excludes slack:private:* and 'unknown:legacy'.
- `writeSessionEndHandoff`: Auto-write a handoff at session-end (DF1 T3) from the session's active snapshot, else from `derived`, its transcript state.

### src/store/index-and-stats.ts
- `saveIndex`: LC1 F1(c) structural fix: `last_retrieval_ids` and `last_trace_id` must land atomically — callers (getContext, cmdRecall) fold a freshly-written trace id into `index.last_trace_id` before calling this, relying on BOTH meta keys committing together. Wrapped in BEGIN/COMMIT so a crash or a mid-write failure can never advance one key without the other. index.json is left untouched; only `rebuildIndex` writes it.
- `rebuildIndex`: AT1 (plan §3, round-3 redesign): same guard-with-per-row-skip as bootstrapLegacyStore — rebuildIndex is the other channel through which a stale markdown mirror could resurrect a rejected value. Refusal audit written INLINE (nothing rolls back on a skip).

### src/store/mirrors.ts
- `getExistingEntryMirrorPaths`: AT1 mirror-purge honesty fix (docs/plans/2026-08-15-at1-rejected-value-tombstone.md): the candidate markdown mirror paths still on disk for `id`, computed the same way `removeEntryMirrors` walks them (one per layer: buffer/episodic/ semantic), filtered to the ones that still `fs.existsSync`. Used to report an EXPLICIT path when a best-effort purge fails and no reaper exists to retry it — plain `removeEntryMirrors` returns void, giving no way to name which file is stuck.

### src/store/open.ts
- `importLegacyEntries`: AT1 (plan §3, round-3 redesign): run the guard LIVE per row rather than bypassing it. bootstrapLegacyStore is exactly the channel through which a stale/never-purged markdown mirror could resurrect a rejected value; a skip-and-count here closes that structurally, independent of mirror state. The refusal audit is written INLINE inside this still-open loop transaction (plain audit() — nothing is rolled back on a per-row skip, so the post-rollback auditRejectionRefusal helper is the wrong tool here).
- `importLegacyIndexAndStats`: LC1: legacy index.json predates last_trace_id, so this is '' for every pre-v40 store — harmless, matches the ensureMetaDefaults default.

### src/store/rows.ts
- `HippoIndex.last_trace_id`: LC1 (docs/plans/2026-08-02-lc1-recall-trace-persistence.md): id of the most recent recall_traces row written by getContext/cmdRecall, mirrored from the `last_trace_id` meta key exactly like last_retrieval_ids. null when no trace has been written yet (fresh store, pre-v40 flow, or api.recall-only usage — api.recall never sets this).
- `MemoryRow.summary_dirty`: v0.30 / E1 of DAG live-coupling (schema v28). Symmetric with v25 DAG cache: included in MEMORY_SELECT_COLUMNS so every read path populates these alongside descendant_count / earliest_at / latest_at.
- `MemoryRow.bm25_score`: F1 (v1.7.0): present only on rows from MEMORY_SEARCH_COLUMNS (FTS path).
- `MEMORY_SEARCH_COLUMNS`: F1 (v1.7.0): qualified-and-aliased columns for the FTS join in loadSearchRows. Every column is `m.<col> AS <col>` so rowToEntry's unqualified field reads keep working unchanged. The trailing bm25(memories_fts) AS bm25_score adds the FTS rank as a result column. Only used inside the FTS path; non-FTS paths keep MEMORY_SELECT_COLUMNS.
- `rowToEntry`: v0.30 / E1 of DAG live-coupling (schema v28). Symmetric with v25 cache.
- `rowToEntry`: F1 (v1.7.0): preserve bm25_score from the FTS path. `'bm25_score' in row` distinguishes "absent column" (non-FTS path) from "column present but value 0" — though FTS5 bm25() never returns 0, this is defensive.
- `parseLastTraceId`: Strict parse for the `last_trace_id` meta value (LC1 F1(d) structural fix).

### src/store/search-rows.ts
- `RecallScopeFilter`: v1.7.2 — recall-mode scope filter shape, exported so callers (`loadRecallSearchEntries`) and tests can refer to it symbolically without `Parameters<typeof loadSearchRows>[N]` indirection.
- `RecallScopeFilter`: 'default-deny' — exclude scopes in `RECALL_DEFAULT_DENY_SCOPES` (T2).
- `RecallScopeFilter`: 'default-deny-or-exact' (v1.25.0) — the default-admitted set PLUS rows whose scope equals `value`. This is the CLI `--scope` semantics: the flag predates the envelope column as a TAG-boost ranking hint (`scope:<v>` tags, HIPPO_SCOPE), so an explicit flag must UNLOCK the named envelope scope in addition to the normal set rather than narrow the result to it — narrowing would return zero rows for every tag-scoped workflow (envelope scope NULL). Strictly safer than the pre-v1.25.0 CLI behavior (no filter at all): other private scopes and quarantine buckets stay denied.
- `RecallScopeFilter`: @internal v1.7.2 — internal SQL-builder shape; not on the public API surface (not re-exported from `src/index.ts`). Subject to change.
- `loadSearchRows`: v1.7.1 — test/diagnostic hook: `HIPPO_FORCE_LIKE_PATH=1` forces the LIKE-fallback path here only. Gated at the read-call site so writes (`syncFtsRow`, `deleteFtsRow`, `raw-archive.ts::archiveRaw`) keep using `isFtsAvailable` honestly and never silently skip FTS index sync. Lets tests exercise the LIKE branch deterministically without poisoning the on-disk FTS state.
- `searchPredicates`: v1.12.6 — belt-and-suspenders against `kind='archived'` leaking into recall. `kind='archived'` is a transient sentinel inside `archiveRawMemory`'s SAVEPOINT (src/raw-archive.ts:56): UPDATE kind = 'archived' immediately followed by DELETE, both inside one savepoint that commits or rolls back atomically. SQLite atomicity guarantees no concurrent reader sees the intermediate state. This filter is defensive-only against: (a) future bugs that drop the SAVEPOINT, (b) future bugs that introduce kind='archived' as a persisted state, (c) external direct-SQL writes that bypass archiveRawMemory. tenantOnlyPredicate starts with " WHERE tenant_id = ?" when tenant is set; when unset, we have no WHERE yet, so the archived clause needs both AND and WHERE forms. The "tenant-only" path always has WHERE (from tenant or we synthesize one).
- `selectFtsCandidates`: F1 (v1.7.0): MEMORY_SEARCH_COLUMNS adds bm25_score as the trailing result column. Every other column is m.<col> AS <col> so rowToEntry sees the same shape it always has.
- `loadRecallSearchEntries`: Consumers: `api.recall` (v1.7.1+), `cmdRecall`/`cmdExplain` direct CLI paths and `searchBothHybrid` recall mode (v1.25.0).
- `loadRecallSearchEntries`: `tenantId` widened to optional in v1.25.0 for the searchBothHybrid recall mode (its `tenantId` option is optional); `loadSearchRows` already treats undefined as "no tenant filter" for legacy callers.
- `loadRecallSearchEntriesFromDb`: Split out so callers with an already-open db (Z1 prompt-recall path) skip the initStore+open/close cycle per store per call.

### src/store/sessions.ts
- `SNAPSHOT_AMBIENT_MAX_AGE_MS`: Default freshness bound for AMBIENT active-task-snapshot reads (DF1, docs/plans/2026-08-23-df1-snapshot-lifecycle.md): 72h, chosen over 48h so a Friday-evening orphan still offers continuity on Monday morning.
- `loadFreshActiveTaskSnapshot`: Bounded read for AMBIENT active-task-snapshot surfaces (UserPromptSubmit hook context, MCP recall block) — the never-expires fix for DF1.
- `closeTaskSnapshotsForSession`: Close the `active` task snapshot(s) owned by `sessionId`, for the T3 session-end death path (DF1, docs/plans/2026-08-23-df1-snapshot-lifecycle.md).
- `appendSessionEvent`: v1.2: scope is wired through. Default-deny in api.recall + cmdRecall continuity reads applies to slack:private:* and 'unknown:legacy' rows.

### src/store/summaries.ts
- `summaries.ts` (dirty-flag banner): v0.30 / E1 of DAG live-coupling — dirty-flag helpers for the existing DAG layer's level-2 summaries. Used by E2 (child-write propagation in invalidation.ts / writeEntry / forgetMemory / archiveRawMemory) to mark a summary dirty when one of its children changes, and by E3's sleep-cycle rebuildDirtySummaries phase to enumerate candidates without scanning every memory row.
- `loadDirtySummaries`: Sorted by latest_at DESC (NULLS LAST) so E3's rebuild cap (HIPPO_DAG_REBUILD_CAP, default 20) takes the most-recently-changed summaries first.
- `markSummaryDirty`: Called by E2 from invalidation.ts / writeEntry / forgetMemory / archiveRawMemory whenever a child is invalidated, superseded, forgotten, or archived.
- `markSummaryDirty`: Quietly no-ops if the target row doesn't exist or isn't a level-2 summary (E5 will widen the dag_level guard to IN (2, 3) when level-3 build path lands).
- `markSummaryDirty`: v0.30 / E5: widened dag_level=2 -> IN (2, 3). RETURNING dag_level reads actual level in same round trip.
- `markSummaryDirty`: metadata.source=E1 leaves a breadcrumb so E2-E5 debugging can distinguish dirty-marks across the arc's wiring layers.
- `summaries.ts` (rebuild banner): v0.30 / E3 of DAG live-coupling — sleep-cycle rebuild surface.
- `loadAllL2Summaries`: v0.30 / E5 — host-wide loader for L2 topic summaries without an L3 parent. Mirrors loadAllDirtySummaries pattern (E3).
- `loadAllDirtySummaries`: v0.30 / E3 — host-wide variant of loadDirtySummaries.
- `loadChildrenOfSummary`: v0.30 / E3 — load live children of a DAG summary.
- `RebuildPatch`: v0.30 / E3 — patch applied by applyRebuildResult.
- `applyRebuildResult`: v0.30 / E3 — apply a rebuild result to a dirty summary.
- `REBUILD_CONTENT_SQL` / `REBUILD_METADATA_SQL`: v0.30 / E5: widened dag_level=2 -> IN (2, 3) on both branches.
- `applyRebuildInSavepoint`: Return-value semantics (v0.30/T4 split): `changed` reflects whether THIS call's UPDATE (content or metadata-only) affected a row — NOT whether patch.content specifically landed. On a refusal, metadata still applies, so changed=true even though content did not change. This preserves the pre-T4 no-infinite-retry choice: the caller (dag.ts rebuildDirtySummaries) treats changed=false as "race lost, silently retry next cycle" — returning false on a refusal would retry the same doomed LLM rebuild forever, so changed=true settles this cycle (dirty cleared) regardless of refusal. `refused` is the T4 addition: true only when a tombstone hit AND the metadata UPDATE landed (changed=true) — a refusal that loses the race to a concurrent writer reports refused=false too, since nothing from this call took effect. Before T4, a refusal also counted toward the caller's `rebuilt` stat because `changed` alone could not distinguish it; the caller now increments `refused` instead of `rebuilt` when this is true, so the stat reflects what happened without changing dirty-clearing or retry behavior.
- `syncRebuiltSummary`: v0.30 / E5: read actual level from the summary in scope (NOT hardcoded 2). L2 -> 2, L3 -> 3.
- `clearSummaryDirtyAfterBuild`: v0.30 / E3 — clear summary_dirty on a freshly-built summary. Called by buildDag immediately after the child-link loop finishes. Without this, each member's writeEntry call fires markSummaryDirtyInTx on the just- created parent (E2 hook at store.ts:1214), and the same sleep cycle's E3 rebuild phase would re-rebuild every new summary (2x LLM cost). Idempotent: no-op + no audit if summary isn't dirty. Audit source='buildDag-clean' distinguishes from E3-rebuild source.
- `clearSummaryDirtyAfterBuild`: v0.30 / E5: widened dag_level=2 -> IN (2, 3). RETURNING dag_level reads actual level so audit metadata stays accurate without an extra SELECT.
- `clearSummaryDirtyAfterBuild`: v0.30 / E5: source param distinguishes buildDag-clean (L2) from buildEntityProfiles-clean (L3) and any future build path.

### src/token-ledger.ts
- `token-ledger.ts` (module header): Token ledger (ROADMAP Part IX, TE0): what memory text hippo hands agents, and how many tokens it costs.
- `token-ledger.ts` (module header): It also backs TE2, inject only on change: the per-prompt hook compares the hash of the block it is about to send with the last block it sent in the same session and records a `skip` instead of sending it again.
- `TokenSurface`: `hook_recall`: the same hook's Z1 prompt-recall section (docs/plans/2026-09-26-z1-prompt-recall.md).
