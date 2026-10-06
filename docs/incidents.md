# Incidents

Bugs, regressions and review findings that shaped the code. Source comments keep the one-line reason; the story behind it lives here, quoted from the comment it came from.

## History moved out of src/ comments, by module

### src/api/assemble.ts
- `AssembleOpts.scope`: Restrict to a specific scope. v1.6.1 senior-review P1 #3 parity with `recall`
- `AssembleResult.totalRaw`: Pre-v1.6.1 was pre-filter (confusing for all-private sessions); pre-v1.6.3 was capped (under-reported on sessions > rowCap). v1.6.3 reports the FULL post-filter count via a separate COUNT(*) query so consumers can render "session has N msgs" accurately even when items[] is the windowed view.
- `assemble`: v1.6.3 senior-review P0-1: report the FULL post-filter row count even when the cap windows the loaded set. Pre-v1.6.3 used `scoped.length` which under-reported on long sessions and made consumers render wrong "session has N msgs" UX.
- `assemble`: v1.6.3 codex P1 / senior P0: scope-aware unbounded COUNT. The helper SQL-encodes the same default-deny rule passesScopeFilterForRecall applies in TS, so a no-scope caller cannot infer private rows by comparing totalRaw to items.length on a truncated session.

### src/api/auth.ts
- `authCreate`: v1.12.4: audit emit (closes the gap v1.12.3 CHANGELOG flagged as deferred). Mirrors the auth_revoke pattern at authRevoke — same try/catch so audit failure can't crash a successful mint.
- `AuthRevokeResult`: Audit: emits 'auth_revoke' with `tenantId` set to the KEY ROW's tenant_id (M1 fix from A5 review, mirrors src/cli.ts:cmdAuthRevoke).
- `authRevoke`: tenantId: row.tenantId, // M1: KEY's tenant, not ctx.tenantId.

### src/api/outcome.ts
- `outcome`: MUST return `appliedIds` instead of the raw input list — otherwise the non-applied (cross-tenant) ids leak to the caller. Added in v1.11.4 to close that disclosure path on POST /v1/outcome.
- `outcomeForLastRecall`: **Tenant-safe response shape (v1.11.4 security fix):** the returned `ids` field contains ONLY the tenant-filtered subset that actually had outcomes applied (i.e. `appliedIds` from the inner `outcome()` call). Earlier versions returned the raw `last_retrieval_ids` regardless of tenant, which leaked cross-tenant memory IDs to the caller via POST /v1/outcome's no-body last-recall response. The fix is at this helper so all callers (CLI cmdOutcome, HTTP /v1/outcome, MCP `hippo_outcome` if added later) inherit the tenant-safe contract.
- `outcomeForLastRecall`: LC1 F1(d) structural fix (docs/plans/2026-08-02-lc1-recall-trace-persistence.md): read the trace id from the SAME `loadIndex` snapshot already in hand (idx.last_trace_id) — a single-snapshot read, not a second DB round trip via a now-deleted readLastTraceId helper. The value is already strict-parsed by buildIndexFromDb's parseLastTraceId (store.ts): every consumer gets a clean positive-integer string or null, never a garbage value that could reach outcome() and INSERT trace_id=0/NaN. null on a fresh store / pre-v40 flow / api.recall-only usage — outcome() skips linkage silently when traceId is undefined.

### src/api/recall-types.ts
- `RecallOpts.scorerWindow`: `scorerWindow: 0` or non-finite values throw `RecallContractError` with code `invalid_scorer_window` to prevent the v1.6.x footgun where 0 fell through to an uncapped fallback (codex v1.7.0 diff-pass P1).
- `RecallResult.windowSize`: Optional in the type to keep `RecallResult` literal-construction back-compatible with pre-v1.7 test fakes / mocks (senior review P1-2).
- `RecallResult.planningFallacyWatching`: v1.13.4 / J3.2 follow-up — "watching" variant emitted when the forward-claim regex matched but no baserate could be produced. Dogfood diary (docs/dogfood/2026-05-27-track-j-warnings.md) Trial 2a confirmed the pre-v1.13.4 silent-no-class-match path was the dominant J3.2 failure mode, because natural-language queries rarely share non-stopword tokens with class tags.

### src/api/recall.ts
- `recallWindowSize`: F5 (v1.6.5) preflight — codex P1: original guard fired AFTER loadSearchEntries (which runs initStore, migrating legacy state on first call). For a true contract preflight we want the throw before any store-touching work. Single check here; the consumer site at `if (freshTailCount > 0)` does NOT re-validate (would be a no-op).
- `recallWindowSize`: F3 (v1.7.0): scorerWindow opt-in. When undefined (default), loadSearchEntries uses its own store-internal default — this preserves every pre-v1.7.0 caller's behaviour bit-for-bit (codex mk2-pass P0-1: defaulting to `limit` would have shrunk the candidate pool and killed overflow summaries). DEFAULT_SEARCH_CANDIDATE_LIMIT is imported from store.ts so the two values cannot drift (codex diff-pass P1 #3). Validate the input — codex diff-pass P1 #1 caught that scorerWindow=0 would route through FTS/LIKE LIMIT 0 and then fall through to an uncapped full-store fallback. Reject non-positive / non-finite values.

### src/api/types.ts
- `RecallContractError`: 'invalid_scorer_window' — `opts.scorerWindow` is set to a non-positive, non-integer, or non-finite value. Pre-v1.7.0 the value 0 routed through FTS/LIKE `LIMIT 0` and then fell through to an uncapped full-store fallback (codex v1.7.0 diff-pass P1). Validated upfront so the contract holds.

### src/audit.ts
- `CJK_LETTERS`: Two properties this must hold, both learned from codex review findings: 1. Letters only, enforced by construction. Two separate wrong guesses were caught here: a Katakana BLOCK range counts the middle dot and prolonged sound mark, and `\p{Script=Han}` alone still counts Han-script NON-letters (Kangxi radicals, the old Chinese hook mark) because Script properties are not restricted to letters. The `(?=\p{L})` lookahead makes "letters only" true by definition rather than by assertion, and the category sweep in tests/df3-cjk-quality-floor.test.ts pins it so the next wrong guess fails locally instead of in review.
- `hasNoSpecificity`: An ACRONYM is specificity too, and this test could not see one: the proper-noun pattern needs lowercase after the capital, so "PR", "CI", "DB", "API", "S3" - the densest domain tokens in a technical memory - all read as vague. Surfaced by DF2: clause-bounding correctly shortened "The rule is every PR needs two approvals, no exceptions." to "every PR needs two approvals", which then fell under the 40-char vagueness gate and was silently DROPPED - a rule that stored before this branch.
- `hasNoSpecificity`: ...but an acronym only signals specificity when it stands out AGAINST ordinary prose. Without the lowercase requirement, any shouted phrase qualifies: "FIXED SIGNALS" passed the gate while the identical "fixed signals" was correctly rejected, so capitalization alone bought a bypass - into auditMemory and includeRecent as well, where junk would then occupy recent-context slots. Codex P2, r8.
- `hasNoSpecificity`: CHAT acronyms are not domain signal. Admitting any all-caps token let "LGTM ship it", "TODO fix this thing", "FYI all done here" through a gate that correctly rejected them before - and this gate is shared, so the effect is retroactive: junk rows already in a user's store were filtered out of recent-context slots and would have started occupying them, and `hippo audit` would have stopped flagging them. Found at the ship gate.

### src/capture/command.ts
- `captureExtractedItems`: AT1 P2 fix (dry-run parity, docs/plans/2026-08-15-at1-rejected-value-tombstone.md): dry-run used to skip the guarded write branch ENTIRELY, so a tombstoned extraction printed as `[capture]` and counted toward `captured` — the preview lied about what a real run would do. Mirrors importers.ts's importEntries dry-run probe (commit 6146e82): open a read-only handle once, run the same checkRejectionGuard the real write path uses via writeEntry, never write anything.

### src/capture/compact.ts
- `truncateKeepNewest`: Keep the LAST maxChars instead, aligned forward to a nearby line start, with a trim marker (codex round 3).
- `resolvePreCompactTranscript`: A payload transcript_path is EXCLUSIVE: never fall back to newest-transcript auto-discovery when it's missing/unreadable. That fallback would snapshot a DIFFERENT session's transcript under THIS payload's session_id — cross-session contamination with wrong linkage (verify-stage E2E finding, 2026-08-03). Auto-discovery only applies on a true manual invocation (no payload at all).
- `saveDerivedSnapshot`: CX6 (codex round 2): field fallback must never move content across sessions — session A's task carried into a snapshot saved under session B's id would pass compact-resume's session gate wearing the wrong badge.

### src/capture/extract.ts
- `PREFERENCE_PATTERNS`: `PREFERENCE_PATTERNS[0]` is the one exception — its two-capture-group shape means something different (two content spans either side of "instead of"/"over"/"not") and is a separate, backlogged defect (see docs/plans/2026-08-23-df2-capture-anchoring.md); left as-is.
- `boundToClause`: The whitespace requirement on the terminator is load-bearing: a bare `[.!?]` would split inside a token like `.env` / `capture.ts` / `v1.35.0`, turning a full clause into a fragment that then fails the write gate and is silently dropped (measured in the plan).
- `lastCloserIndex`: ONE pass, not one per apostrophe. The previous shape rescanned the whole remaining suffix at every boundary apostrophe, so a transcript full of elisions ("keep 'em", "wait 'til", ...) made extraction quadratic and could stall a moderately sized capture. Codex P2, r7.
- `lastCloserIndex`: A quote CLOSES THE SIDE IT IS TIGHT AGAINST. The test needs both neighbours, and one round proved that empirically: these two have the same following character and opposite roles - so no forward-only rule can separate them. An earlier revision tried exactly that and broke in both directions at once (codex P1+P2, r10): it missed closers before token-joining punctuation and accepted "'.env" as a closer because a dot happened to be in its class.
- `lastCloserIndex`: "tight against content" excludes an OPENING delimiter: in "call parse('--force" the paren is non-whitespace but the quote after it is an opener, and treating it as a closer let an earlier elision pair across the clause boundary. Codex P2, r11.
- `lastCloserIndex`: Punctuation splits in two, and this is the fact the last three revisions kept rediscovering piecemeal:
- `boundToClause`: Depth-awareness is not a nicety here: hippo memories are full of code, and a naive scan reintroduces the exact fragment defect this whole change exists to remove. Measured before this guard existed: "Always call build(x, y) before deploy." -> "Always call build(x" "Never pass {a: 1, b: 2} to the writer." -> "Never pass {a" Both then PASS the write gate, because they contain code punctuation and so read as "specific" — a malformed fragment stored with high confidence. Codex review finding (P1) on this branch.
- `closesQuote`: Closing uses the SAME shape test as opening. This was asymmetric: twelve rounds went into deciding when a quote OPENS a literal, while the close accepted any bare "'" - so the apostrophe in a possessive INSIDE a literal closed it early: "Always pass 'user's a, b list' to the parser." -> "Always pass 'user's a" (master kept the whole literal) a mid-literal fragment that then PASSES the write gate, which is precisely the defect this branch exists to remove. Found by the ship-gate review after every earlier gate missed it.
- `opensSingleQuote`: Both were codex P1s on this branch, in consecutive rounds.
- `opensSingleQuote`: Requiring an actual closing quote later in the string replaces a guess with a checkable fact - an elided form simply has no partner. Codex P2, this round.
- `opensSingleQuote`: So apply the SAME shape rule already used to open a literal, mirrored: a closer has non-whitespace before it and whitespace/punctuation (not a letter) after. "user's" fails it on both counts. Codex P2, r6.
- `extractFromPatterns`: ONLY colon-terminated labels are dropped. Dropping "the X is/was" too left the residue starting with "to ", which isFragment then rejected outright - so "The plan is to ship on Friday" and "The fix was to bump the pool timeout" stored NOTHING, where every prior version stored them. Silent loss on two of the highest-traffic patterns, and invisible: an absent memory leaves no trace. The AT1 rejected-value evidence only ever involved colon labels ("decision: "), so the narrower rule keeps that guarantee.
- `extractFromPatterns`: Scan the UNTRUNCATED remainder, not match[2]. The patterns cap their content group at 500 chars, so a quoted literal whose closer sits past that point had no visible partner and the pairing check read the opener as prose - cutting inside the literal. That was a blindness built into the scanner's INPUT, not a bad predicate, so no further predicate could have fixed it. boundToClause already caps its OUTPUT at maxLen, so widening the input costs nothing and makes pairing decidable on the whole sentence. Codex P2, round 5.
- `extractFromPatterns`: Group 2's REAL offset, read from the regex engine. Deriving it as `match.index + rawPrefix.length` assumes group 1 starts the match, but DECISION_PATTERNS carry an uncaptured subject ("we ", "let's ") ahead of it - so the offset landed inside the keyword and the widened slice duplicated text: "We decided to pin..." stored as "decided to to pin...". Real corruption of the commonest decision capture, shipped in the previous commit. Codex P1, r6.

### src/cli.ts
- `maybeRepairCodexWrapper`: Never first-installs — silently swapping the codex binary on routine commands is a consent violation and reads as binary hijacking to supply-chain scanners (issue #133).
- `main`: Global --scope well-formedness guard (v1.26.2). parseArgs stores a value-less flag as boolean true; downstream the 14 consumer sites either coerced that to the literal scope string 'true' (recall filter/unlock input, wm session scope, the remember scope-tag dual-write) or silently dropped the user's scoping intent (the remember envelope WRITE). Reject it once here, mirroring the --hops value-less guard, so every current and future command - including the thin-client dispatch relays - sees --scope only as a non-empty string.

### src/cli/audit.ts
- `cmdAuditList`: Regenerate from Set to prevent future drift (v1.11.5: pre-v1.11.5 message was hand-maintained and had drifted — missed 'auth_revoke' and 'outcome').

### src/cli/curate.ts
- `cmdOutcome`: Behavior fix (v1.11.3): cmdOutcome used to bypass api.outcome and do its own readEntry/writeEntry inline, which silently skipped the audit_log emission that the MCP outcome path already has via api.outcome. T6 rewires through api.outcome so every successful CLI 'outcome' call now writes one audit_log row per affected id, matching MCP parity.
- `cmdReject`: Ambiguous ask: silently preferring one form would ignore the other without feedback (code-review round-1 low).

### src/cli/dag.ts
- `cmdDrillDown`: v1.6.4: only `not_drillable` is caller-actionable. `not_found` intentionally collapses cross-tenant + scope-blocked + missing (codex round 3 P1: distinguishing scope_blocked leaked existence).

### src/cli/decisions.ts
- `decideCreate`: A value-less `--supersedes` (parseArgs stores boolean true) is a malformed request: the user asked to supersede but gave no memory id. Reject it rather than silently creating a non-superseding decision (codex review 2026-05-28).
- `decideCreate`: Backward-compat: --supersedes takes a MEMORY id. Validate it exists and resolve it to the active decision row (if any). Grill fix: commit the canonical table create+supersede FIRST (inside saveDecision's SAVEPOINT), weaken the old memory LAST (best-effort) so a memory-write failure cannot leave the memory stale without the table reflecting the supersession.
- `decideCreate`: Best-effort: saveDecision already committed the canonical mutation (new decision created + old row superseded). If this legacy memory-weaken throws, do NOT fail the command — a retry would find no active decision for the old memory and create a duplicate active successor. Warn instead (codex review 2026-05-28).
- `parsePositiveIncidentId`: Strict positive-integer parse for incident id args. parseInt() alone accepts trailing junk ("1abc" -> 1), which would let a mutating subcommand (close/ resolve) silently hit the wrong row; require the whole arg to be digits. (codex P2, 2026-05-29.)

### src/cli/init.ts
- `installUserLevelHooks`: The Codex capture wrapper swaps the codex launcher binary, so init only points at the opt-in (issue #133).

### src/cli/playbooks.ts
- `parsePositiveProcessId`: Strict positive-integer id parse for the mutating process subcommands. parseInt alone accepts trailing junk ('1abc' -> 1), which would let `process close 1abc` / `supersede 1abc` silently hit the wrong row; require the whole arg to be digits. (Mirrors parsePositiveIncidentId; codex P2, 2026-05-29.)
- `parsePositivePolicyId`: Strict positive-integer id parse for the mutating policy subcommands (mirrors parsePositiveProcessId; codex P2 class - parseInt alone accepts '1abc' -> 1).
- `parsePositiveSkillId`: Strict positive-integer id parse for the mutating skill subcommands (mirrors parsePositivePolicyId; codex P2 class - parseInt accepts '1abc' -> 1).

### src/cli/remember.ts
- `cmdSupersede`: AT1: write the SUCCESSOR first. The rejection guard fires on the new content — if it refuses, nothing has been mutated yet (the old ordering committed old.superseded_by before the guarded new write, leaving a dangling pointer to an id that was never created). If the old-row write below fails instead, the new row exists unpointered — an orphan successor, strictly less harmful than a dangling pointer. NOTE: unlike api.supersede (whose CAS + insert commit in ONE transaction), this CLI path is two independent writes and stays non-atomic; write order is its only ordering guarantee.

### src/cli/session-hooks.ts
- `cmdCompactResume`: Same exit-0/crash-safety contract as `hippo pre-compact` (critic round 2): every path exits 0.
- `cmdCompactResume`: X3: gate on the non-exiting isInitialized check before any store-opening call (loadActiveTaskSnapshot/listSessionEvents both call initStore internally, which would silently create a store in a project that never ran `hippo init` — this hook fires globally).
- `cmdCompactResume`: X13: fail closed on malformed non-empty stdin. The earlier "print on malformed" behavior survives only for TTY/no-stdin manual invocation (nonEmptyStdin is false there, this branch never runs).
- `cmdCompactResume`: Fail closed on structurally incomplete payloads too ({}, [], source missing/non-string): any parsed non-empty payload must say source === 'compact' to print. Real SessionStart payloads always carry source; only the TTY/no-stdin manual path prints without one (codex round 3).

### src/cli/transfer.ts
- `importVaultFolder`: --name is the vault identity key for the destructive source-deletion sync; inferring it from the folder basename let same-basename vaults collide and clobber each other (codex R10 P2). A valueless `--name` parses as boolean true, and String(true) === "true" would silently import under vault:true:* - reject a non-string so it fails fast instead (codex R11 P2).
- `importVaultFolder`: Example uses the source-prefixed private form, since a bare `private` scope is NOT treated as private by recall and importVault rejects it (R13 P2).

### src/compaction-spool.ts
- `importSpool`: Replayers used to claim a spool file by renaming it to `<file>.claimed`, and on Windows two renames of one file can both land, so both processes imported it. Node's `renameSync` onto an existing name succeeds there too. A two-process probe of that claim pattern (Windows, Node 24.19, 2,000 legacy files a round, three rounds) imported 693, 752 and 779 files twice on 2026-10-06; discovery had measured 277, 512 and 536. With `replay.lock` and the claim time in the claim name, the probe through the built module (1,800 files from `spool()` plus 200 legacy names a round) gave 0 doubles, 0 missing, 0 `.bad`, 0 files left and no log line other than "spool left to another replayer" in all four rounds. Round 4 started from a lock 11 minutes old and 10 stale claims (5 new-style, 5 legacy `.json.claimed`): the lock was taken over and all 10 claims were put back and imported once. The probe is `spool-race-probe.mjs` in devrl episode 01M47RP8A4ZNHXRBAVRAC38SGY; `tests/compaction-spool-race.test.ts` is its 300-file CI form, which on step-2 code imported 394 of 300.
- `spoolFile`: Names were `<sessionId>-<ms>.json`, so a replay went in session-id order and two spools of one session in one millisecond shared a name, the second replacing the first. Names now lead with the time and carry 4 random bytes.
- `importFailed`: A file whose import threw went back unchanged and failed again on every replay. The try count now lives in the name (`a0`, `a1`, `a2`) and the third failure sets the file aside as `.failed.bad`; a busy store keeps the count.
- `settle`: An EPERM on a `.bad` rename (antivirus, the indexer, a pending delete) threw out of the import loop and stopped the whole spool for that run.
- `promoteTmp`: A spool killed between its write and its rename left a whole `.json.tmp` that no replay read, so the summary was lost.

### src/compare.ts
- `compareEntryIdentity`: The metadata keys make byte-identical twins order by what they carry instead of by `id` (`crypto.randomUUID()`), which is per-instance random: before v1.38.1 the dedupe survivor of two twins that differed only in tags or source was whichever id sorted first, and a semantic/episodic pair always kept the episodic copy because `mem_` sorts before `sem_`.
- `comparePhysicsResultsBy`: callers that need CROSS-INGEST stability supply `tieKeyOf` mapping the result to its memory CONTENT (codex review finding: the baseScore tie order selects the cluster_top_k amplification set, which MUTATES scores before the downstream content-aware merge sort runs -- so the tie key must be content-stable at THIS layer, not just downstream).

### src/config.ts
- `memoryValueOverride`: Review-round F6: {...DEFAULT_CONFIG.memoryValue, ...raw.memoryValue} silently no-ops when raw.memoryValue is a non-object (e.g. the user wrote {"memoryValue": true}) — spreading a boolean/primitive/array contributes no enumerable own properties, so `enabled` stays at the default `false` with zero indication anything was wrong. This feature's whole point is "never silently off": warn loudly and fall back to defaults instead of merging garbage.

### src/connectors/github/backfill.ts
- `module header`: Crash safety (codex P1 #3): each stream's HWM is persisted ONLY after
- `module header`: Codex P1 #2: the /issues endpoint returns BOTH issues and PRs (a PR is
- `drainStream`: any other fetch error so the caller leaves the HWM unchanged (round 1 codex P1 #3 crash safety). v1.3.1 (round 2 codex P1s + claude P1): ... to next=null. Callers MUST NOT advance the HWM when drained=false. Was a bug in v1.3.0: hitting maxPerStream cap returned the partial maxUpdatedAt and the caller persisted it, skipping the unfetched tail.
- `drainStream`: v1.3.1: track updated_at on EVERY item, before the toIngestEvent filter. Skipped PRs from /issues still contribute to the HWM so PR-only pages don't loop forever.
- `issueItemToEvent`: Codex P1 #2: /issues returns PRs too — skip them.
- `backfillStream`: v1.3.1: only advance HWM when the stream actually drained. A capped run (--max) must leave the HWM at its previous value so the next invocation re-fetches the unprocessed tail.

### src/connectors/github/cli-impl.ts
- `cmdGithubDlqReplay`: v1.3.1 hotfix (codex P1): without an ingestHook the v1.3.0 CLI was a dry-run that printed "replay ok" while only bumping retry_count. Wire the real hook so `replay` actually re-runs the ingest path.
- `cmdGithubDlqReplay`: v1.3.2 (codex round 3 P1): a replayed `issue_comment.deleted` or `pull_request_review_comment.deleted` row must route to the deletion handler, NOT to ingestEvent. The v1.3.1 hook unconditionally called ingestEvent and would have written the deleted comment as a NEW raw memory instead of archiving the matching ones.

### src/connectors/github/deletion.ts
- `handleCommentDeleted`: Codex round 1 P0 #5: filter by tenant_id + kind='raw'. Multi-row archive: ... Claude round 2 P0 #2 (v1.3.1 hotfix): the v1.3.0 implementation called archiveRaw N times in a loop, each opening its own DB handle and SAVEPOINT. The first archive's afterArchive committed the idempotency mark. If archive 2..N threw, idempotency was already committed and retry returned 'duplicate' with archivedCount=0 — survivors stayed searchable, leaking private bodies. v1.3.1 fix: ONE shared DB handle wrapping ALL archives + the idempotency mark in a single outer SAVEPOINT. Any per-row failure rolls back the entire batch (including idempotency), so retry re-attempts cleanly. archiveRawMemory (the lower-level function from raw-archive.js) runs its own inner SAVEPOINT which nests safely inside the outer one.

### src/connectors/github/dlq.ts
- `module header`: installation_id, repo_full_name. Codex P1 #5 mandates this rich context so a `hippo gh dlq replay` operator can triage without re-deriving anything from the raw payload.
- `ReplayDlqOpts.previousSecret`: Previous webhook secret during rotation (v1.3.1 hotfix — claude P1).
- `IngestHook`: v1.3.2 (claude review): the v1.3.1 contract advertised an `idempotencyKey` field, but the v1.3.1 ingest re-derives the key from the parsed event itself, so the field was a phantom — any future hook that trusted the passed-in value would dedupe against a stale key. Field removed.
- `replayDlqEntry`: v1.3.2: dropped the stale idempotencyKey arg — the hook re-derives it from the parsed event (artifact_ref + updated_at) since v1.3.1.

### src/connectors/github/ingest.ts
- `module header`: ':' + rawBody) (codex P0 #3) — derived from the signed body, not from the
- `module header`: Race semantics (codex P1 #6):
- `module header`: The Slack precedent's race test was insufficient — it tested the fast path, not the SAVEPOINT collision. The `__testInjectBeforeLog` hook below lets tests pre-populate github_event_log inside the SAVEPOINT to actually exercise the changes=0 -> rollback path.
- `IngestInput.rawBody`: The raw HTTP body — used for the idempotency key (replay-safe per codex P0 #3).
- `eventArtifactRef`: v1.3.1: extract the source-normalized identifier the idempotency key needs.
- `rememberWithEventLog`: v1.12.0: drop the legacy `|| 'connector:github'` fallback (see slack/ingest.ts:73 for rationale).

### src/connectors/github/octokit-client.ts
- `module header`: Codex P1 #4 mandate: any non-200 response that is NOT a recognized rate-limit pause MUST throw `GitHubFetchError`. Silently turning 401/403/404/500 into empty pages produced empty backfills with no operator signal, so this code path is now load-bearing.
- `realGitHubFetcher`: Codex P1 #4: don't silently turn 401/403/404/500 into empty pages.

### src/connectors/github/signature.ts
- `computeIdempotencyKey`: Source-aware idempotency key. v1.3.1 hotfix (codex round 1 P0 #3 + claude round 2 P0 #3). Round 1 design: sha256(eventName + ':' + rawBody) so an attacker rotating X-GitHub-Delivery cannot bypass dedupe. Round 2 found that key produced different hashes for the SAME source event delivered via webhook vs via REST backfill, because backfill rawBody is the REST list-item shape while webhook rawBody is the envelope. Result: backfill + later webhook of the same issue created two `kind='raw'` rows with the same artifact_ref. Combined with the deletion bug, deletion could not archive both. v1.3.1 fix: key from the SOURCE-NORMALIZED identifier — artifact_ref plus the source-side updated_at timestamp. Same artifact + same revision = same key, regardless of which path delivered it. Different revisions of the same issue (an edit) get different keys, which is correct: each edit IS a new memory revision.
- `computeIdempotencyKey`: Migration note for v1.3.0 → v1.3.1: existing github_event_log rows from v1.3.0 used the round-1 key shape and will not collide with v1.3.1 keys. The first webhook delivery after upgrading creates a new log row with the new key. This is acceptable for a hotfix (no production users on v1.3.0) and correct semantics going forward.
- `computeDeletionKey`: v1.3.2: deletion-specific idempotency key. Distinct namespace from computeIdempotencyKey so an ingest's row in github_event_log doesn't make a deletion event return 'duplicate' before it gets a chance to archive. The codex round 3 P0 fix on server.ts was to call computeIdempotencyKey with the right (artifactRef, updatedAt) shape for deletions. That made the deletion key MATCH the ingest key — which collapsed to a "deletion always returns duplicate" bug because both shared github_event_log. v1.3.2 splits the namespace: deletion key = sha256('deleted:' + artifactRef + ':' + updatedAt). Two retries of the SAME deletion event still dedupe (same artifact + same updatedAt + same prefix → same key). Ingest of the same artifact + same updatedAt produces a DIFFERENT key, so a deletion event does not get short-circuited by the ingest's prior log row.

### src/connectors/github/tenant-routing.ts
- `resolveTenantForGitHub`: account — codex P0 #4 regression target)

### src/connectors/github/types.ts
- `module header`: Codex P1 #7: `private` MUST be optional, not required. The Slack-style

### src/connectors/slack/deletion.ts
- `handleMessageDeleted`: Handle Slack `message_deleted`. v0.39 commit 3 closes the prior race where the archive committed but `markEventSeen` ran on a second db handle — a crash between them left the deletion event un-acked, and the next retry hit a now-archived row and returned `not_found` instead of `duplicate`. Fix: pass `afterArchive` to `archiveRaw`, which runs inside the same SAVEPOINT as the archive itself. The slack_event_log row commits with the archive or not at all.

### src/connectors/slack/ingest.ts
- `ingestMessage`: correct under two-worker concurrency (v0.39 commit 3 fix).
- `ingestMessage`: v1.12.6 fix (B3): empty-body events mark seen with memory_id=NULL on first call (see line further down). Their replay should return the same 'skipped' status they originally returned, not 'duplicate' — the asymmetry was a paper-cut for callers that switch/case on status. memory_id=NULL is the discriminator. Non-NULL memory_id means an actual memory was ingested before, so 'duplicate' is correct.
- `rememberWithEventLog`: v1.12.0: drop the legacy `|| 'connector:slack'` fallback — ctx is always provided by server.ts:1039 which constructs it with the connector subject. Under the new object-shaped Context.actor, an OR-fallback would evaluate an object as truthy and skip the fallback anyway (logic bug if ctx were ever missing); explicit reliance on the caller is safer.

### src/connectors/slack/tenant-routing.ts
- `resolveTenantForTeam`: v0.39 commit 3 (CRITICAL #5): the previous version returned null on miss unconditionally, and the route handler then fell back to HIPPO_TENANT — which silently routed events from a foreign workspace into the deployment tenant. The fail-closed contract lives here so every caller (route handler, CLI replay, future MCP) gets the same protection.

### src/connectors/slack/transform.ts
- `messageToRememberOpts`: Codex round 1 P1: skipping userless messages instead of stamping a bot owner would silently drop existing bot ingestion via the "skipped but seen" path at ingest.ts:54-65.

### src/consolidate/decay.ts
- `decayWithMemoryValue`: Carried forward to logRun, where the mv_rescue audit rows are actually written (code-review fix: writing them here, before batchWriteAndDelete, would assert rescues for a cycle whose effects might never land if a later phase throws).
- `decayWithMemoryValue`: Fail-loud must not depend on condemnation traffic (round-2 code-review P2-2): validate the frozen weights constant unconditionally, even on a sleep with nothing condemned.
- `decayWithMemoryValue`: Compute the per-tenant ranking ONCE (round-2 code-review P2-2): rankById feeds both rescueSet's decision (via precomputedRanks, skipping its own internal rankNonPinnedByTenant call) and the detail/audit rank context below, so the whole-store ranking pass runs a single time per sleep instead of twice, and only when there is actually something condemned to rank against.
- `decayWithMemoryValue`: (review-round F4: rescued entries used to be appended at the tail of survivors, systematically starving them in downstream order-sensitive passes like extraction's slice(0,20) — a single pass over `all` preserves flag-off's ordering semantics exactly.)
- `decayWithMemoryValue`: Rescued (D1): standard survivor stored-strength refresh (P2-1).

### src/consolidate/llm-passes.ts
- `dagRebuildPass`: R1 MED must-fix: hard ceiling so misconfigured env can't burn unbounded LLM cost.

### src/consolidate/merge.ts
- `mergePass`: T1 fix (2026-08-15 hardening pass): partition by tenantId BEFORE the overlap loop so a cluster can never span tenants. Previously textOverlap clustered across the whole host-wide `survivors` list with no tenant boundary, and mergeContents concatenated cross-tenant content into one row. Map preserves insertion order, so single-tenant stores (every row 'default') get exactly one partition and iterate in the same order as before this fix — byte-identical behavior there.
- `mergeCluster`: AT1 P2 fix: build the semantic entry FIRST — createMemory is cheap and pure — so the tombstone check below runs under the tenant the row will ACTUALLY land in. T1 fix: createMemory now receives tenantId: mergeTenant (the partition's tenant — every member of `cluster` shares it by construction), so the row lands in its source tenant instead of always 'default'.

### src/consolidate/run.ts
- `lazyConsolidateDb`: T3 fix (2026-08-15 hardening pass, perf hygiene): memoized lazy getter, not an eager open. The handle only serves these two tombstone checks — a sleep with zero promotable sessions and zero merge clusters never reaches either use site, so opening it unconditionally on every non-dry-run sleep paid a db-open cost for nothing. dryRun still never opens (getConsolidateDb short-circuits before touching the handle). consolidateDbOpened (not just a truthy handle check) is the single source of truth for "was this ever opened", so the finally closes it exactly once and never double-opens.
- `lazyConsolidateDb`: AT1 P2 fix (codex, handle-leak restructure): the getter's lifetime must start IMMEDIATELY before the try whose finally closes it, covering every phase that can touch it — not just the merge pass. An exception thrown by auto-promote (1.4), replay (1.5), batch extraction (1.6), the DAG passes (1.7-1.9), or physics (2) would otherwise propagate past an open handle with nothing to close it.

### src/consolidate/sleep.ts
- `auditRescues`: Review-round F5: per-row try/catch, not one try/catch around the whole loop — a single failed appendAuditEvent must not silently drop every remaining row. Mirrors the physics pass's skipped-warning precedent: count losses, keep the overall fail-soft posture, tell the operator via details.

### src/consolidate/traces.ts
- `sessionTrace`: T1 fix (2026-08-15 hardening pass): stamp the trace into the SAME tenant the traceExistsForSession idempotency check (above) runs under. Before this, createMemory omitted tenantId and the trace always landed 'default' (memory.ts:535) while the idempotency check ran under consolidationTenant — for any non-default tenant that check never hit, and the trace regenerated every sleep.

### src/customer-notes.ts
- `preflightNoteSupersede`: Mirrors saveProjectBrief / saveSkill (codex P1 2026-05-28).
- `saveCustomerNote`: The memory mirror carries a `customer:<lc>` tag (in addition to ['customer_note'] + caller extraTags) so scope-aware recall treats the note as entity-local - the project_brief codex-P2 recall-locality lesson applied to entity scoping.
- `closeCustomerNote`: Closing removes the object from the graph. Remove its rows DIRECTLY (deterministic), not only via an enqueued rebuild whose queue item is lost if the mirror is later forgotten (the queue row cascade-deletes with the memory), which would leave the closed object stale and could block that forget (codex P1).

### src/dag.ts
- `partitionFactsByTenant`: Hardening follow-up (mirrors consolidate.ts's mergeCandidatesByTenant, T1): partition unparented facts by tenantId BEFORE clustering so a cluster can never mix facts from different tenants into one LLM-synthesized summary. Map preserves insertion order, so single-tenant stores (every row 'default') get exactly one partition and iterate in the same order as before this fix — byte-identical behavior there.
- `summarizeCluster`: (2x LLM cost). plan-eng-r1 HIGH must-fix.
- `rebuildDirtySummaries`: Per-summary try/catch isolation (plan-eng-r1 MED must-fix) — one throwing rebuild does NOT abort the rest of the queue.
- `rebuildDirtySummaries`: Per-summary failure isolation — one throw doesn't abort the queue. independent-review MED #2 fold: log enough to triage in production (audit() wraps its own writes try/catch per store/audit-event.ts, so a throw here is exotic: SQLite I/O error, prepare failure, etc).
- `EntityProfilesBuildResult.failed`: independent-review MED #3 fold: surface failure counter so operators see LLM null / rate-limit / 401 signal (parity with DagRebuildResult.failed).
- `partitionL2sByTenant`: independent-review HIGH #1 fold: cluster ONLY within-tenant. clusterFacts has no tenant awareness; without this partition step a multi-tenant host could form a cluster spanning tenants and produce a single L3 with tenantId='default' that doesn't belong to either child tenant. Fix: bucket by tenantId, run clusterFacts per-tenant, pass tenantId to createMemory.
- `createProfileEntry`: HIGH #1 fold: thread tenant explicitly

### src/db/continuity.ts
- `ensureContinuityTables`: Before the loop on stamped stores: a table lost after its migration stamped (2026-08-15 incident) is never re-migrated, and v4/v16/v22 ALTER or read it.

### src/db/migrations/v15.ts
- migration v15: A3 hardening (post-review): close the NULL-kind bypass and add raw_archive dedup safety. Both findings landed in /review on commits 41b1f4d..6456e7d.

### src/db/migrations/v17.ts
- migration v17: Multi-tenant routing seam (review patch #6).

### src/db/migrations/v21.ts
- migration v21: v0.39 codex round 3: per-row mirror cleanup tracking.

### src/db/migrations/v22.ts
- migration v22: Tenant-isolation gap on continuity tables (codex review 2026-05-02). session_events and session_handoffs predate the v16 tenant migration and were never added to it, so the v0.40.0 provenance gate work exposed a real cross-tenant leak when continuity primitives are used.

### src/db/migrations/v23.ts
- migration v23: Quarantine policy (codex round 1 P1): pre-existing continuity rows with NULL scope cannot be safely classified as public after the fact.

### src/db/migrations/v24.ts
- migration v24: PAT-mode multi-tenant routing (codex P0 #4).

### src/db/migrations/v27.ts
- migration v27: Surfaced 2026-05-24 on Keith's ~/.hippo/hippo.db: schema_version recorded as 25 but api_keys and audit_log tables were missing from migration v16. Root cause unknown — the migration runner has wrapped each migration in BEGIN/COMMIT since the first SQLite commit, so atomicity isn't the bug. Possible causes: DROP TABLE post-migration, SQL import / restore from a pre-v16 backup over a v16+ schema_version, or some edge case the wrapping doesn't catch. Cause may be operator action; either way the practical fix is the same.

### src/db/migrations/v33.ts
- migration v33: All date inputs are normalized to canonical ISO-8601 datetime (toISOString) at the store boundary before persist/compare, so the fixed-width values sort lexically and the half-open [valid_from, valid_to) as-of comparison is correct (plan-eng-critic round-1 CRIT fix).

### src/db/migrations/v37.ts
- `TRG_MEMORIES_GRAPH_REFERENCED_GUARD`: Reverse guard (codex-review-critic 2026-06-01, P1): the graph-table triggers only fire on writes to the GRAPH tables.
- `TRG_ENTITIES_NO_TENANT_MOVE_WHEN_REFERENCED`: Reverse guard #2 (codex-review-critic 2026-06-01 retry, P2): an entity that is a relation endpoint cannot be moved cross-tenant.
- migration v37: Both INSERT and UPDATE are guarded: an INSERT-only guard is bypassable via a raw SQL UPDATE that moves a row onto a raw memory (plan-eng-critic 2026-06-01).

### src/db/migrations/v42.ts
- migration v42: codex P2: backfill from session_complete so pre-existing handoffs don't all read as unfinished and get injected by the new 72h ambient fallback.

### src/decisions.ts
- `preflightDecisionSupersede`: Validating first means the new row is never a candidate for its own supersede UPDATE. codex review 2026-05-28 (P1).
- `saveDecision`: Post-commit hook: mark the tenant's graph dirty AFTER the DB row commits but BEFORE the markdown mirrors are written, so a mirror-write failure can never leave a committed save unflagged (codex).
- `closeDecision`: Closing removes the object from the graph. Remove its rows DIRECTLY (deterministic), not only via an enqueued rebuild whose queue item is lost if the mirror is later forgotten (the queue row cascade-deletes with the memory), which would leave the closed object stale and could block that forget (codex P1).

### src/extract.ts
- `storeExtractedFacts`: T1 executor check (2026-08-15 hardening pass): same defect as the consolidate.ts merge/trace passes — createMemory with no tenantId option stamps 'default' (memory.ts:535) regardless of the source entry's own tenant. Thread it through so extracted facts land in the same tenant as the episodic memory they were extracted from.

### src/forward-claim-detector.ts
- `DURATION_TAIL`: Reused fragment for ALL duration-suffix patterns. Requires a digit + unit so 'will take ownership' / 'ship in Docker' (no time component) don't match. Codex round 2 P2: patterns that allowed verb-only matches fired on every-day non-estimate queries that happened to share a class-token.
- `FORWARD_CLAIM_PATTERNS`: Lookbehind asserts start-of-string OR whitespace before the tilde because \b before ~ requires a word char immediately preceding (~ is not a word character), so /\b~/ would only match in 'foo~3 days' (malformed) and silently miss the legitimate cases. Codex review round 1 catch.
- `STOP_WORDS`: Letting them through to class resolution lets a class tag containing 'days' win or tie on the unit token instead of the domain token. Codex round 2 P3 catch.

### src/graph-extract.ts
- `CreatedEntity.superseded`: References are extracted among ACTIVE entities only - an edge to/from a superseded (outdated) row is stale (codex).
- `extractGraph`: WRITE PHASE (codex P2): clear + every insert run in ONE transaction, so two concurrent rebuilds serialize on the SQLite write lock (no duplicate rows) and a throw mid-rebuild rolls back the clear (no bricked graph).
- `insertEntityRows`: Normalise the label so a long/odd-but-valid E2 name can never throw in insertEntity and (because clearGraph already ran) brick the rebuild unrebuildably. E2 name fields (decisionText / policyName) are UNCAPPED at source, and insertEntity REJECTS (not truncates) both an over-cap name AND an empty one. So: TRIM FIRST (codex 2026-06-01: >512 leading-whitespace chars would otherwise slice to a whitespace-only string -> trimmed to '' -> 'name is required' throw), THEN cap to MAX_ENTITY_NAME_LEN; if the normalised label is empty (the E2 save APIs forbid this, but be defensive) skip the row rather than throw. This closes the entire name-brick class.
- `extractReferences`: References are among ACTIVE entities only: a superseded (outdated) row is not a current cross-reference target (codex).
- `extractReferences`: ordering longer names before their prefixes makes the match longest-at-position (`postgres pro` wins over `postgres`; codex).
- `extractReferences`: superseded sources hold only stale references (codex)

### src/graph-recall.ts
- module header: 3. BOTH the local and global stores are expanded — a global seed's entities/relations live under the global root, so graph recall must traverse each seed in the store its graph lives in (codex review).
- module header: 4. By-id loads are chunked at 500 (loadEntriesByIds caps at 500/call), so a high-fanout traversal (--hops 3 --max-neighbors 200 -> up to 600 ids) loses none (codex review).
- `graphExpandRecall`: Protect the top --min-results base rows from eviction (graph expansion must not violate the recall min-results floor; codex P2).

### src/graph-stream.ts
- `bestStrengthAtDepth`: Pass 1: accumulate the STRONGEST reaching-seed strength per new neighbour across ALL relations at this depth BEFORE committing any to `visited` (codex P2).
- `graphRankStream`: Seed-exclusion guard (plan-eng-critic MED): graphScore is keyed by entryIndex GLOBALLY across roots

### src/graph-view.ts
- `buildGraphModel`: All reads run inside ONE read snapshot so a concurrent `graph extract` / sleep-drain rebuild can't make the model mix old entity ids with new relation ids (codex P2).
- `buildGraphModel`: (4) Load ALL edges AMONG the union so neighbour-to-neighbour edges that don't touch the focus are included too. (codex P2s.)
- `buildGraphModel`: Edges AMONG the union (BOTH endpoints in the set): includes neighbour-to-neighbour edges, and the LIMIT can never drop a valid in-union edge in favour of out-of-union rows (codex P2).
- `buildGraphModel`: hop.length >= limit || // neighbour scan capped -> a 1-hop neighbour may be omitted (codex P2)
- `buildGraphModel`: neighboursCapped || // node cap filled before all neighbours were consumed (codex P2)

### src/graph/read.ts
- `loadEntitiesByMemoryId`: T2: no ORDER BY meant chunk-local scan order decided ties; id ASC makes it deterministic (entities.id is an autoincrement integer PK).

### src/graph/write.ts
- `resolveConsolidatedSource`: Stale / forgotten mirror. ... the active E2 object survives mirror loss (v38 contract; codex round-4 race).
- `resolveConsolidatedSource`: Validate the object pointer WHENEVER it is provided - not only when memory is null (codex review): a dual-set row whose object is wrong/closed/cross-tenant would become the active provenance after ON DELETE SET NULL and could then block the memory delete.

### src/hooks/codex-wrapper.ts
- `repairCodexWrapperIfInstalled`: doing it from postinstall or routine commands is a consent violation and reads as binary hijacking to security scanners (issue #133).

### src/hooks/json-hooks.ts
- `module header`: OpenCode does NOT share Claude Code's JSON-hook schema — its config has `additionalProperties: false` and no `hooks` key, so v1.10.x-v1.11.1's JSON-hook installer broke opencode launch (issue #24).

### src/hooks/opencode.ts
- `OPENCODE_PLUGIN_SOURCE`: Design choices forced by plan-eng-critic Rev 0 review (2026-05-23):
- `OpenCode plugin installer section`: OpenCode plugin installer (fix for issue #24). OpenCode does NOT share Claude Code's JSON-hook schema. Its config has `additionalProperties: false` and no `hooks` key, so the v1.10.x-v1.11.1 installer broke opencode launch. The fix writes a TS plugin at the canonical plugin path and surgically migrates any pre-existing broken hooks block out of opencode.json.
- `HIPPO_OWNED_COMMAND_RE`: Critic-mandated structural check (Rev 0): substring matching against arbitrary user content is unsafe
- `HIPPO_OWNED_COMMAND_RE`: Per-hook (not per-entry) granularity (Rev 1 review): an entry whose inner hooks array mixes hippo-installed commands with user-authored commands must NOT lose the user-authored commands.

### src/mcp/admin-tools.ts
- `runResolveTool`: P2 fix: resolveConflict's opts.rejectedBy defaults to 'cli' when omitted — this call site never passed it, so the tombstone's rejected_by AND the conflict_resolve audit's actor both landed as 'cli' even though the caller was MCP. ctx.actor carries the auth-resolved actor for HTTP-MCP (see McpContext above); stdio callers pass no ctx, so 'mcp' is the honest fallback there.

### src/mcp/framing.ts
- `module header`: We also accept legacy LSP-style `Content-Length` framing so the printf-and-pipe smoke test from issue #13 still works.

### src/mcp/recall-tools.ts
- `runRecallTool`: Telemetry: caller had no sessionId so ring tracking skipped. Per the recall-audit convention at api.ts:854, use SHA-256/16 for prompt hashing (NOT hashQueryText which is FNV-1a 32-bit for recall matching; brute-force trivial for low-entropy queries). Codex round-2 P2 catch.
- `drill-down tool`: v1.6.4: only not_drillable is caller-actionable. not_found intentionally collapses cross-tenant + scope-blocked + missing (codex round 3 P1: distinguishing scope_blocked would leak private-row existence on this surface).

### src/memory-value.ts
- `MIN_RESCUE_GROUP`: Review-round F1 (small-tenant degeneracy): below this per-tenant non-pinned candidate-set size, a rank statistic is noise — E2's evidence says nothing about tiny scale
- `scoreEntries`: Review-round F2 (non-finite features): Date.parse on a malformed `created` string yields NaN, and NaN would silently corrupt every OTHER entry's min-max in the same group.
- `rankNonPinnedByTenant`: F9: guard undefined tenantId the same way dag.ts:341 does — the MemoryEntry type says `string`, but a raw/legacy row can still carry undefined at runtime, and grouping it under the literal key "undefined" would silently split it into its own singleton tenant.
- `rankNonPinnedByTenant`: score DESC -> compareEntryIdentity (content asc -> metadata -> id asc), the shared deterministic tie-break used by every score-primary sort site in this codebase (src/compare.ts). F2: `-Infinity - -Infinity` is NaN, not 0 — two non-finite-feature entries tied at -Infinity would otherwise fall through to `diff` (NaN), which Array.sort treats as "no preference" and leaves insertion-order-dependent. Route NaN through the same deterministic tie-break as an exact-zero diff.
- `rankNonPinnedByTenant`: F1: tenants smaller than MIN_RESCUE_GROUP never rescue (keepN 0) — see that constant's doc comment.
- `rescueSet`: `precomputedRanks` (round-2 code-review P2-2): when the caller has already computed the per-tenant ranking
- `rescueSet`: F2: Number.isFinite(info.score) is an explicit, absolute guard — not just reliance on -Infinity naturally sorting last. In the degenerate case where every entry in a tenant is non-finite-scored (a tie at -Infinity), rank position alone could otherwise place one inside keepN; this makes "never rescued" hold regardless.

### src/memory.ts
- `LOSS_AVERSION_RATIO_MIN`: tuning range. See codex-review-critic round 1 P1.
- `getLossAversionRatio`: Validation policy (v1.13.5 + independent-review round-1 HIGH + codex round-1 P1 folds):
- `getLossAversionRatio`: codex-review-critic round 1 P1: rejecting only `0` (the original HIGH fold) leaves the same silent data-loss surface for any ratio
- `calculateStrength`: EVAL-ONLY ablation (see ablation.ts): with recall-strengthening ablated, anchor decay at CREATION, not last_retrieved. A never-strengthened memory decays from when it was made; using last_retrieved would let clock resets persisted by PRIOR unflagged runs leak strengthening into an ablated arm's rankings (codex P2). Identity on fresh stores (created == last_retrieved at write). Prior-run half_life increments are NOT reconstructed - see the ablation.ts caveat (fresh stores per arm).
- `calculateStrength`: EVAL-ONLY ablation (see ablation.ts): the recall-boost flag neutralizes the READ side too, so a store with PRIOR retrieval history (counts > 0 written before the flag was set) does not leak strengthening into an ablated arm's rankings (codex P2).

### src/physics.ts
- `computeMass`: EVAL-ONLY ablation (see ablation.ts): under the recall-boost flag, particle mass must not scale with retrieval history either - query gravity ranks by mass, so prior retrieval counts would leak strengthening into the ablated arm's physics-pool rankings (codex P2). Covers both the init and refresh callers in physics-state.ts.

### src/policies.ts
- `asOfInstant`: comparison is correct (plan-eng-critic round-1 CRIT fix: a date-only asOf vs a datetime valid_from otherwise made a same-day policy invisible).
- `preflightPolicySupersede`: Mirrors saveProcess / saveDecision (codex P1 2026-05-28).
- `savePolicy`: hide a superseded predecessor for that earlier time (codex review 2026-05-30 round 2). An explicit --from is honored as-is.
- `closePolicy`: object stale and could block that forget (codex P1). Still enqueue when a mirror exists
- `loadActivePolicies`: superseded in May is still the answer for `asof March`. (codex review 2026-05-30, P2 #2: filtering on status='active' alone dropped historically-valid superseded versions, conflating transaction-time with valid-time. The successor-aware filter mirrors the existing recall-history.ts asOf pattern.)
- `loadActivePolicies`: common create-then-asof-today workflow, keeping the stored valid_from honest (codex review 2026-05-30). A full datetime asOf is used as the precise instant.

### src/postinstall.ts
- `main`: Repair-only: re-ensure the wrapper for users who previously opted in (e.g. a Codex update restored the real binary over our shim). A first install never happens here — swapping the codex binary from a package postinstall is a consent violation and reads as binary hijacking to supply-chain scanners (issue #133). First install is `hippo hook install codex` only.

### src/predictions/planning-fallacy.ts
- `PlanningFallacyWatching`: v1.13.4 / J3.2 follow-up — "watching" variant emitted when the forward-claim regex matched but no PlanningFallacyHint baserate was returned. Dogfood diary (docs/dogfood/2026-05-27-track-j-warnings.md) Trial 2a confirmed the pre-v1.13.4 silent paths were the most common real-world J3.2 failure mode: a natural-language query carries a ... any prediction class tag, so hippo silently emitted nothing despite
- `resolveClassFromTokens`: Scope behaviour (v1 design choice, independent-review-critic round 1 MED): class_tag selection is TENANT-GLOBAL, NOT scope-filtered against

### src/predictions/store.ts
- `closePrediction`: Codex review finding 2026-05-26: WHERE clause requires closure_state='open' so duplicate close requests / retries against an already-closed prediction return a clear error instead of silently overwriting actual_value + emitting a duplicate predict_close audit row.
- `computePredictionBaserate`: Plan-eng-critic round 1 HIGH recommendation: emit inside helper, not at 3 call sites.

### src/processes.ts
- `preflightProcessSupersede`: Mirrors saveDecision (codex P1 2026-05-28).

### src/project-briefs.ts
- `preflightBriefSupersede`: Mirrors saveSkill / saveProcess (codex P1 2026-05-28).
- `closeProjectBrief`: which would leave the closed object stale and could block that forget (codex P1).
- `fitReceiptLines`: NOTE on ordering: the `id DESC` tiebreak is lexical on a random-ish memory id ... `created DESC` is the real recency ordering. (plan-eng-critic 2026-05-30, med.)
- `fitReceiptLines`: Budget-aware assembly (codex-review-critic 2026-05-30, P2): the digest is the brief `summary`, which saveProjectBrief caps at MAX_BRIEF_SUMMARY_LEN. The receipt/headline caps (50 x ~200) could otherwise build an ~11KB body that the store then REJECTS, breaking refresh for inputs within the advertised caps.
- `refreshBrief`: Tag the refreshed brief's mirror as repo-local so path-aware recall boosts it like the manual `brief new`/`supersede` paths do (codex-review 2026-05-30, P2).

### src/recall-history.ts
- `hashQueryText`: Token dedup before join: the R2 contract says "distinct queries" means semantically distinct, so `foo bar` and `foo foo bar` should collapse to the same hash. Without dedup, simple phrasing variations (typos, doubled tokens, intensifiers) would inflate distinct-query counts and trip R2 on essentially the same question. Codex round-1 catch.
- `hashQueryText`: Unicode-aware tokenization (codex round-3 P2 catch): the prior ASCII-only [^a-z0-9\s] pattern stripped every non-Latin letter, so Japanese, Arabic, Cyrillic, accented-Latin etc. queries collapsed to empty token set -> hash 0 -> false R1 collisions across distinct non-English queries. \p{L} = any Unicode letter, \p{N} = any Unicode number, \p{M} = combining marks (preserve composed accented chars). Requires the /u flag and Node >= 12.
- `hashQueryText`: Drop tokens shorter than 3 chars to match the normalizer contract (filler / stop words). Without this, `a login bug` vs `login bug` hash differently and inflate R2 distinct-query counts, firing memory_dominance on repeated phrasings of the same question. Codex round-4 P2 catch. Matches the same >=3 filter in src/forward-claim-detector.ts for class-resolver tokens.
- `hashQueryText`: Fallback when the >=3 filter would collapse the entire query to empty: CJK queries like `测试` / `环境` are 2-char tokens; English acronyms like `AI` / `UI` are 2 chars. Without this fallback they all hash to fnv1a32(''), producing false R1 collisions across distinct short-token queries. Codex round-5 P2 catch.

### src/recall-trace.ts
- `sanitizeRerankSteps`: Strip a RerankStep down to {stage, multiplier, scoreBefore, scoreAfter} before persisting (F3 privacy fix, codex cross-model finding).
- `writeRecallTraceAtRoot`: F1 structural fix (replaces the earlier stamp-then-clear design): this function does NOT touch the `last_trace_id` meta key. Stamping lived here originally, on its own connection, separate from the `last_retrieval_ids` write in `saveIndex` — two connections meant two commits, so a crash or a failed second write could advance one without the other.
- `recordTraceOutcome`: F4 validation (codex cross-model finding): `traceId`/`memoryIds` reach this function from caller-side state (`last_trace_id` / applied outcome ids) that can go stale relative to the trace it names

### src/reject-flow.ts
- `RejectFlowResult.removedIds`: all whose normalized digest matched (not just the id passed, per the K1/R7 duplicate lesson)
- `assertRejectOpts`: P2 fix: the CLI's flag parser already refuses both forms together; the shared flow itself didn't enforce it, so a direct api caller passing both silently got the memoryId path with `value` ignored — surprising for a caller who thought they were rejecting `value`.
- `removeLiveRows`: suppressForgetAudit: the aggregate reject_value row below is the trail for these removals, not N individual forget rows (plan §4, round-3 advisory 2 — mirrors api.ts:1873-1877).
- `purgeRemovedMirrors`: AT1 fix: purgeMirrorBestEffort retries once, then — for non-raw ids, which cleanupArchivedMirrors' reaper never scans — reports the EXPLICIT leftover path(s) instead of the false "will retry via reaper" claim.
- `unrejectValue`: P2 fix: an empty/blank prefix startsWith-matches EVERY digest (every string starts with ''), which would previously fall through to the ambiguous-candidates branch and list the whole tombstone set instead of failing loud on the actually-invalid input. Reject before the DB round trip.

### src/rejection.ts
- `checkRejectionGuard`: P2 fix: also read tenant_id. Content-digest-only comparison let a same-id upsert that ONLY changes tenantId slip through as an "unchanged re-persist" — content C sitting quietly (never rejected) in tenant A could be re-tagged into tenant B, and since C's digest already matched this row's stored digest, the guard exempted it even though B is the tenant that rejected C (that is WHY `tombstone` above is non-null: the lookup already ran under the INCOMING/destination tenantId). A tenant change on the SAME id is therefore always a content introduction into the destination tenant, exactly as if the row were new there.

### src/secret-detect.ts
- `SECRET_PATTERNS`: `token = estimateTokens(entry.content)` and "the secret: incremental-rollout worked well" were verified false positives that would silently hide real code-lesson memories from ambient context (post-merge adversarial review, 2026-07-02).

### src/server.ts
- `VERSION`: v1.3.1: source from src/version.ts so /health no longer reports stale 0.39.0.
- `setKeepAliveTimeouts`: T3b capture (v1.26.2): tests/server-concurrency.test.ts's ECONNRESET flake traced to a chunk-boundary reuse race — a kept-alive socket idled through a prior response chunk gets closed by the server's default 5s keepAliveTimeout just as a client reuses it for the next request. Raising both timeouts shrinks that idle-close/reuse window ~13x. Keep headersTimeout ABOVE the EFFECTIVE keep-alive expiry, which is keepAliveTimeout + keepAliveTimeoutBuffer (the buffer defaults to 1,000ms on Node 22.19+/24.6+ — verified 1,000 on node 24.13, so the effective expiry here is 66s; codex review caught that a 66s headersTimeout would sit exactly ON that boundary and recreate the race). The headers timer also runs while a kept-alive socket waits for its next request, so a value at or below the effective expiry would itself close idle reused sockets, and Node would not flag it (no error or warning at listen time — verified empirically).

### src/server/request.ts
- `rejectEncodedSlash`: codex round 3 P2: only scan the PATHNAME portion of the raw URL, not the query string. Pre-fix, `?q=https%3A%2F%2Fexample.com` would 400 because the regex matched `%2F` anywhere in `req.url`. Recall queries containing URLs would have been rejected as bypass attempts. Splitting on the first `?` confines the check to the path.

### src/server/routes/memories.ts
- `handleGetGraph`: Cap at the graph entity-name cap (512), not the id-shaped 256, so a valid long decision/policy name remains focusable over HTTP (codex P2).
- `handleSleep`: Future non-loopback serving must also zero the cross-tenant counters for other tenants (D1 in docs/decisions/2026-05-24-blocked-items.md).

### src/server/routes/recall.ts
- `parseFreshTail`: Pre-v1.6.2 the route silently ignored these so the session-scoped fresh-tail and summary substitution were JS-only.
- `parseFreshTail`: v1.6.3 senior-review P1-3: cap session_id length consistent with the rest of the API.
- `parseRecallQuery`: v1.6.3 senior-review P1-4: tighten parser to match the includeContinuity convention. Pre-v1.6.3 accepted any non-'0'/'false' value as `true`, so `?summarize_overflow=banana` and `?summarize_overflow=` both turned it on. Surface convention drift fixed.
- `snapshotSessionRing`: Codex round-5 P2 catch: do NOT mutate sessionRecallHistoryHttp before recall() preflight runs. A request with an invalid scorer_window / fresh_tail_count would create-or-touch the session ring (LRU-evicting valid sessions) even though recall throws 400. Snapshot the EXISTING ring if present; only create-or-touch after the recall returns successfully.
- `snapshotSessionRing`: Codex round-2 P2 catch: hashQueryText is a 32-bit FNV-1a designed for recall matching, NOT a privacy hash; brute-force trivial for low-entropy queries. Use the same SHA-256/16 truncation as the canonical recall audit.
- `handleRecallMemories`: Codex round-5 P2 fix: create-or-touch the ring ONLY HERE, after recall returns successfully. Invalid requests that throw 400 in recall() never reach this point, so they cannot LRU-evict valid sessions.
- `handleAssembleSession`: v1.6.3 senior review P1: same strict-parse convention as the v1.6.3 summarize_overflow tighten on /v1/memories. Pre-v1.6.3 accepted any non-'0'/'false' as true; ?summarizeOlder=banana now correctly returns false (matches includeContinuity convention).

### src/server/validation.ts
- `parseListLimit`: Shared across the decision/incident/process/policy list routes so the guard cannot drift (codex review 2026-05-30 P2: fractional limit reached SQLite on the policy route; the same latent hole existed in the sibling routes this was copied from).

### src/shared.ts
- `promoteToGlobal`: v39 S4 producer veto: promote is a producer path to the global store exactly like shareMemory - same hard rule (codex gating review P2).
- `searchBothHybrid`: When an admission filter is active, lift the per-store candidate cap (default 200): excluded rows matching the query could otherwise fill the window before any admitted row is even loaded (codex gating round 6). 5000 = 25x the default 200-row window: large enough that exclusion crowding is a non-issue on real stores, bounded so a common query term on a 100k-row store cannot stall an interactive call by ranking every match (post-merge adversarial review, 2026-07-02).
- `syncGlobalToLocal`: v39 (codex P1-4): syncing down must not re-import what ambient context excludes

### src/skills.ts
- `MAX_EXPORT_SKILLS`: Aggregate bound on a single export render (plan-eng-critic: cap the unbounded export body).
- `validateSkillFields`: skill_name is trimmed and MUST be a single line (no newlines) so it cannot break the H2 header in the export render (plan-eng-critic).
- `validateSkillFields`: Single-line, like skill_name: a trigger is a short "when to apply" phrase, and a newline would let it forge a heading inside the export **When:** line (independent-review 2026-05-30). Reject rather than emit a multi-line trigger.
- `preflightSkillSupersede`: Mirrors saveProcess / savePolicy (codex P1 2026-05-28).

### src/store/delete-and-batch.ts
- `batchWriteAndDelete`: BEGIN IMMEDIATE (codex delta-review P2): the AT1 tombstone probes below READ before the first write. Under a deferred BEGIN, that read pins a WAL snapshot; a concurrent writer (e.g. `hippo reject`) committing between probe and first upsert would make the later write-lock upgrade fail with SQLITE_BUSY and roll back the ENTIRE batch — the exact race the probe exists to contain. Taking the write lock up front serializes the probe and the writes on one consistent snapshot.
- `batchWriteAndDelete`: independent-review-critic R1 HIGH: consolidate.ts/sleep flushes through this path every cycle; without these hooks parents NEVER get marked dirty for the dominant mutation source (decay, merge, garbage-collect).
- `applyBatchWrites`: AT1 P1 fix (codex, batch-transaction rejection race): the producer-side check (e.g. consolidate.ts's merge pass) runs BEFORE this transaction, on a different connection. A `hippo reject X` that commits in that window is invisible to it — a queued same-id write of X already sitting in `toWrite` (decay/replay re-persist, or a merge built before the reject) would silently re-INSERT the just-rejected row via the blind bypass. Fix: one indexed point probe per batch entry, on THIS connection, INSIDE this transaction — closes the race regardless of which write class hits it. N is small per sleep, so the extra query per entry is cheap. Skip, don't throw: the batch must still complete for every OTHER entry. Skipping is correct for every write class here — a merge summary skip just means that rollup is absent this cycle (its source facts stay merely demoted, recoverable next sleep); a skipped demotion/replay re-persist of a rejected-removed row means it stays gone, which is the entire point of the tombstone.
- `isRejectedBatchWrite`: Codex delta-review P2 fix: reuse checkRejectionGuard rather than a bare tombstone probe — the guard's content-INTRODUCTION classification must apply here too. A tombstone can legitimately coexist with a live same-content row (resolveConflict deliberately excludes keepId from its sweep; unreject-then-re-reject windows), and an unconditional skip would starve that row of decay/replay metadata updates forever. The guard throws only when the write is new-row or changes content TO the rejected value; unchanged same-id re-persists pass through, exactly as on the writeEntry path.

### src/store/entry-reads.ts
- `loadSessionRawMemories`: Cap semantics (v1.6.2 codex fix): when `cap` is provided, the NEWEST `cap` rows are loaded — `ORDER BY created DESC LIMIT cap` server-side, reversed to oldest-first client-side. Pre-v1.6.2 ordered ASC + LIMIT, which silently dropped the newest rows and broke fresh-tail in assemble.
- `countSessionRawMemories`: v1.6.3 codex P1 / senior P0: an earlier draft of this helper ran an unscoped COUNT, which let a no-scope caller infer the existence of private rows by comparing `totalRaw` against `items.length`. This version SQL-encodes the same default-deny rule `passesScopeFilterForRecall` applies in TS:
- `loadFreshRawMemories`: v1.6.2 codex review fix: pre-v1.6.2 was tenant-wide only. With multiple concurrent sessions in a tenant, fresh-tail recall surfaced unrelated rows from other sessions and stamped them `isFreshTail=true`. Callers that want session-scoped fresh-tail now pass `sessionId`. The tenant-wide form (no sessionId) still exists for "anything new across the whole tenant" — pass undefined to opt in.
- `loadFreshRawMemories`: T2: tie tail keeps the LIMIT window keyed on `created` while making same-`created` rows deterministic. `content` before `id` (codex review): ids are random UUIDs, so an id-only tail would pick WHICH same-created rows make the window per-instance; content is cross-ingest-stable.

### src/store/entry-row.ts
- `upsertEntryRow`: AT1 P1 fix (codex, batch-transaction rejection race): the producer check above runs on a DIFFERENT connection BEFORE this transaction opens — a `hippo reject X` that commits in that window is invisible to it. This parameter's contract is UNCHANGED (still the sole bypass, still trusted by the producer-side check for the common case); what changed is that `batchWriteAndDelete` no longer trusts it BLINDLY. It now runs its own in-transaction point-probe (same connection, same digest lookup this function's guard would have done) immediately before each upsert and skips — rather than writes — any entry whose content matches a tombstone that landed after the producer's check. See batchWriteAndDelete for the skip logic.
- `stampOriginProject`: A writeback (e.g. markRetrieved on a crossProject-included row) must not launder it into an injectable origin - the migration is the only evidence-based NULL converter (codex gating round 2 P1).
- `stampOriginProjectForImport`: a shared row imported into the global store keeps its owning project instead of becoming user-global (codex gating round 3 P1).

### src/store/handoffs.ts
- `loadLatestHandoff`: codex P2: restrict to each session's newest revision first — stampHandoffOutcome only stamps the newest row, so an older null-outcome revision must not resurrect.
- `loadLatestHandoff`: codex P2: admit scope before LIMIT 1, else a newer denied row hides an older eligible one.
- `writeSessionEndHandoff`: codex P2: same-task refresh carries forward envelope fields nobody cleared, rather than dropping them when the snapshot rewrite has no opinion on them. codex P1: a scope mismatch must not leak private metadata into an unscoped envelope.

### src/store/mirrors.ts
- `removeEntryMirrors`: AT1 P1 fix (codex): `writeMarkdownMirror` writes ANY layer's mirror, including `trace/<id>.md` for Layer.Trace rows (auto-promoted traces, consolidate.ts) — but this enumeration only walked Buffer/Episodic/Semantic. A rejected/forgotten trace row's markdown content survived on disk while the purge (and `hippo reject`/plain `forget`) reported success, and a stale trace mirror is exactly the resurrection channel bootstrapLegacyStore/rebuildIndex guard against. Fixes BOTH the AT1 reject-flow purge and the pre-existing plain-`forget` gap for trace rows (deleteEntry has always called this same function).
- `getExistingEntryMirrorPaths`: AT1 P1 fix (codex): same missing Layer.Trace as removeEntryMirrors above — kept in lockstep with it since this function's whole purpose is walking the mirror paths "the same way removeEntryMirrors walks them" (see its own doc comment).
- `purgeMirrorBestEffort`: AT1 fix: best-effort markdown-mirror purge shared by `reject-flow.ts`'s `rejectValue` and `resolveConflict`'s post-commit purge. Both used to log "will retry via reaper on next open" for EVERY failure, but the reaper (`cleanupArchivedMirrors`, raw-archive-mirror-cleanup.ts) only scans `raw_archive` — that message was false for a non-raw id, which has no reaper at all. Retries the unlink once synchronously (the common real-world failure is a transient lock/AV-scanner false positive, not a permanent one). On a second failure: raw ids still get the honest reaper message (true); non-raw ids get the EXPLICIT leftover file path(s) and a manual-delete instruction, since nothing will ever retry them automatically.
- `buildIndexFromDb`: LC1 codex round-2 med: the two lockstep keys must be read in ONE statement. Two autocommit SELECTs leave a window where a concurrent saveIndex (which commits both keys in one transaction) lands between them, handing the reader mismatched last_retrieval_ids / last_trace_id and re-opening the mislinkage hole saveIndex's BEGIN/COMMIT closed on the write side. One SELECT = one SQLite read snapshot.

### src/store/open.ts
- `isInitialized`: A bare .hippo directory is not enough — autoInstallHooks / setupDailySchedule can create it without ever calling initStore, leaving a partial directory (integrations/, logs/, runs/) with no hippo.db. Returning true in that state caused `hippo init` to skip initStore and `hippo recall` to silently fall back to an empty store (incident 2026-04-26: ingest_direct.py against a bare .hippo). Treat the store as initialized only if hippo.db actually exists.
- `bootstrapLegacyStore`: AT1 P2 fix: memoryCount alone is not a reliable "already bootstrapped" signal once the rejection guard exists. If EVERY legacy mirror row is rejected, memories stays at 0 rows even after a successful bootstrap pass, so the memoryCount>0 gate above never trips — every subsequent initStore() call would re-run this whole function: re-scan the legacy mirrors, re-attempt (and re-refuse, re-auditing) every row, and re-INSERT the legacy consolidation_runs rows with no dedup, duplicating them on each open. A dedicated meta flag marks bootstrap as attempted-and-settled regardless of how many rows actually landed.
- `bootstrapLegacyStore`: AT1 P2 fix: stamp completion regardless of how many rows actually landed (all-rejected included) — see the gate comment above.
- `importLegacyIndexAndStats`: Coerce like its neighbors below coerce theirs (independent-review-critic LOW finding): accept only a clean digit string, else fall back to '' rather than trusting whatever a hand-edited/corrupt index.json carries.

### src/store/search-rows.ts
- `loadSearchRows`: F3 (v1.7.0) self-review: empty-query path is the second uncapped path (codex diff-pass caught the full-store fallback at the bottom; this no-terms path had the same shape). Apply LIMIT so all four candidate paths honour the caller's cap when set.
- `loadSearchRows`: F3 (v1.7.0) codex P1: pre-v1.7.0 the full-store fallback ignored `limit` and could return the whole tenant store. With scorerWindow now reported on RecallResult, an unbounded fallback would lie about candidate-pool size. Apply LIMIT here so all four paths honour the caller's cap.
- `loadRecallSearchEntries`: v1.7.1 — recall-mode loader. Pushes the recall-side scope predicate into SQL so `unknown:legacy` cannot leak via any consumer that hasn't remembered to re-filter (root-cause-over-patches: codex flagged this on v1.6.5 review).
- `loadRecallSearchEntries`: Private-scope (`<source>:private:*`) exclusion: SQL applies a conservative pre-window approximation (`NOT LIKE '%:private:%'`, v1.25.0 — codex P2: post-window-only filtering let private rows starve admitted candidates out of the LIMIT window); the exact anchored regex (`passesScopeFilterForRecall`) remains the authoritative JS post-filter in the recall consumers.

### src/store/summaries.ts
- `applyRebuildInSavepoint`: AT1 P1a fix (docs/plans/2026-08-15-at1-rejected-value-tombstone.md): applyRebuildResult's bumpRebuildCount branch wrote patch.content via a direct UPDATE, bypassing the rejection guard entirely (the guard lives in upsertEntryRow's INSERT path, which this function never calls). A rebuild that regenerates byte-identical content to an already-rejected value (e.g. deterministic summarization of an unchanged child set) would silently re-assert it every sleep cycle. Check BEFORE choosing which UPDATE to run — only the bumpRebuildCount branch ever writes content, so a miss or a zero-child call is a no-op here (one indexed point query, guarded path only).
- `syncRebuiltSummary`: FTS sync — bare UPDATE on memories does NOT update memories_fts. R1 HIGH must-fix from plan-eng-r1. Construct the patched entry in memory and reuse the existing syncFtsRow helper (delete-then-insert). earliest_at/latest_at preserve null semantics (R2 must-fix). AT1: content stays summary.content (unchanged) when the write was refused — applyContentWrite is false, so patch.content was never written to the row FTS must mirror.
