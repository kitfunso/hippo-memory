# Hippo internal roadmap gap memo - 2026-08-19

## Scope and method

This is a bounded internal audit, not a repository-wide review. Evidence was limited to the requested ROADMAP/README slices, `package.json`, targeted searches and excerpts from five source modules (`src/eval-suite.ts`, `src/replay.ts`, `src/skills.ts`, `src/memory.ts`, `src/store.ts`), plus `git status --short` and `git log -20 --oneline`. No tests, generated outputs, full diffs, or benchmark artifacts were read.

Recommendation: accept all five candidates only in the narrow forms below. They are complementary: assertions define desired memory behavior; capsules make retrieval decisions reproducible; freshness checks external validity; induction turns successful episodes into reviewable procedures; reliability calibration estimates how much to trust a source. None should become an autonomous mutation or ranking mechanism without the stated gates.

## Accepted gaps

### 1. User-authored memory assertions and a memory-CI runner

**Gap.** Hippo has positive retrieval evaluation, but no first-class operator contract such as "this value must be current," "this memory must not appear," or "these two scopes must never mix," executable against a live or fixture store.

**Exact repository evidence.** `src/eval-suite.ts:32-36` defines `FeatureTestCase` with `expectedIds` only. `runFeatureEval` scores returned IDs against those positives with MRR, R@5, and NDCG@5 (`src/eval-suite.ts:298,316-318`). There is no negative-ID or current-value assertion in that test-case contract. The persistence substrate already exposes provenance and governance fields in `MemoryEntry`, including `source`, `confidence`, `parents`, `source_session_id`, and `artifact_ref` (`src/memory.ts:52-105`).

**Roadmap overlap check.** This directly overlaps AT5's planned must-not-appear fixtures (`ROADMAP.md:1174-1176`) and the comparative benchmark contract's cheap negative-retrieval, stale-answer, and correction canaries (`ROADMAP.md:156-176`). It is not a second eval framework: make user-authored assertions the durable input format and compile a bounded subset into those existing canaries. It also supports the unified control plane's inspect/correct audit flow (`ROADMAP.md:125-139`).

**First slice.** Add a versioned assertion object with three predicates only: `must_recall`, `must_not_recall`, and `current_value`, each tenant/scope bound and carrying author, reason, query, and optional as-of time. Provide one command that runs assertions read-only and emits machine-readable pass/fail plus retrieval-trace IDs.

**Dependencies.** LC1 retrieval traces; AT5 content-exclusion semantics; correction/supersession behavior; tenant and scope enforcement.

**No-go boundary.** Assertions do not pin, delete, correct, or auto-create memories. CI must not send arbitrary private content to external judges. Do not generalize v1 into an unrestricted query language.

**Effort.** 4-6 engineering days after the AT5 representation is settled.

**Falsifiable gate.** On a fixture containing a current value, a superseded value, a cross-tenant near-duplicate, and an irrelevant high-BM25 distractor, the runner must (a) fail when each fault is deliberately injected, (b) pass after restoration, (c) produce the same verdict on two consecutive runs, and (d) add zero store mutations. Every recall/consolidation/mutation PR must run a cheap fixed subset in CI within 60 seconds.

### 2. Immutable retrieval/context capsules with deterministic replay and context diffs

**Gap.** Hippo records memories, snapshots, events, and recent recall-trace identity, but lacks an immutable receipt for the exact context an agent received and a replay operation that distinguishes corpus drift, policy/config drift, and ranking drift.

**Exact repository evidence.** `HippoIndex.last_trace_id` records only the most recent recall-trace row identity (`src/store.ts:73-77`). `saveActiveTaskSnapshot` is current-state oriented: it supersedes the prior active snapshot before insertion (`src/store.ts:2138-2166`), while `appendSessionEvent` stores event breadcrumbs (`src/store.ts:2252-2284`). Neither symbol is an immutable, content-addressed assembled-context receipt. The existing `src/replay.ts` explicitly implements biological rehearsal during consolidation (`replayPriority`, `sampleForReplay`; `src/replay.ts:2-9,37-62,85-110`), not replay of a prior retrieval/context decision.

**Roadmap overlap check.** LC1 supplies per-recall candidates and scores (`ROADMAP.md:1111-1113`); CS1 preserves state across compaction (`ROADMAP.md:1133-1142`); explainable/control-plane recall exposes why a memory surfaced (`ROADMAP.md:125-139`). None freezes the final ordered context, policy/config versions, exclusions, token budget, and source memory revisions as one immutable object. The capsule should reference LC1 rows rather than duplicate their schema.

**First slice.** On explicit opt-in, write a content-addressed capsule containing query hash (raw query optional), ordered memory IDs plus immutable revision/content hashes, final rendered-context hash, trace ID, tenant/scope, as-of time, token budget, and versions of ranking/policy/config. Add `capsule replay` and `capsule diff` modes that are read-only and classify changes by input, corpus, policy, scorer, or renderer.

**Dependencies.** LC1 traces; stable memory revision hashes; version identifiers for scorer, policy, renderer, and config; redaction rules from the model-run privacy contract.

**No-go boundary.** Do not store raw prompts, outputs, secrets, or chain-of-thought by default. Replay must never strengthen retrieval counts, apply outcomes, or mutate lifecycle state. A capsule is an audit receipt, not another canonical memory copy.

**Effort.** 6-9 engineering days for an opt-in CLI/API slice.

**Falsifiable gate.** Replaying a capsule against its pinned revisions must reproduce byte-identical ordered IDs and rendered-context hash. After controlled changes to one memory, one policy weight, and one renderer version, the diff must attribute each change to the correct class, with no false "identical" result. Cross-tenant capsule lookup must return not-found.

### 3. Source freshness contracts with active revalidation

**Gap.** Hippo models memory age and epistemic tier, but it does not model an external source's validation contract or actively verify that a source-backed assertion remains true.

**Exact repository evidence.** `MemoryEntry` stores a free-form `source`, categorical `confidence`, and optional `artifact_ref` (`src/memory.ts:52-105`). `resolveConfidence` exempts pinned/verified entries and otherwise returns `stale` solely after 30 days since retrieval/creation (`src/memory.ts:443-454`). It does not consult the source, a validator, a source revision, or an expiry/recheck policy. README likewise describes staleness as 30 days of non-retrieval and revival on recall (`README.md:379-399`), which measures use, not external truth.

**Roadmap overlap check.** Hybrid retrieval already applies "freshness" as a ranking policy (`ROADMAP.md:141-154`), the benchmark contract measures stale answers (`ROADMAP.md:164-176`), and AT2 separates stale state from epistemic tier (`ROADMAP.md:1162-1164`). Active revalidation is distinct: it changes validation metadata only after checking an authoritative artifact, rather than inferring truth from retrieval recency.

**First slice.** Define a source-freshness contract with `validator_type`, `source_revision`, `checked_at`, `recheck_after`, `validation_status`, and failure reason. Implement only local `file://` artifacts in v1 using content hash/mtime and an explicit operator command; mark changed/missing/unchecked without rewriting memory content.

**Dependencies.** Provenance envelope and `artifact_ref`; AT2's separate staleness facet; audit log; later connector-specific validators and rate-limit/backoff policy.

**No-go boundary.** No arbitrary URL fetching, browser execution, or unattended correction in v1. A failed check must not hard-delete, silently supersede, or downgrade a human-verified claim. "Could not validate" must remain distinct from "false."

**Effort.** 4-6 days for schema/CLI plus one local validator; each connector validator is separate work.

**Falsifiable gate.** Given an unchanged, changed, deleted, and unreadable local artifact, revalidation must deterministically emit `valid`, `changed`, `missing`, and `error`; retain the original memory; write an audit receipt; and make the status visible to assertion CI. The controlled stale-answer fixture must improve with revalidation enabled without reducing useful R@5 beyond a preregistered non-inferiority margin.

### 4. Successful-episode to proposed procedure/skill induction, human-gated and replay-evaluated

**Gap.** Hippo can store active skills and identify promotable completed sessions, but it does not induce a proposed reusable procedure from repeated successful episodes, hold it outside the active set, and replay-evaluate it before human activation.

**Exact repository evidence.** `src/skills.ts` defines only `active`, `superseded`, and `closed` states (`SkillStatus`, `VALID_SKILL_STATES`; lines 34-42). `saveSkill` creates the memory mirror and skill row and can supersede an existing active skill (`src/skills.ts:200-324`); `exportSkills` renders active skills into agent instructions (`src/skills.ts:454-476`). Separately, `findPromotableSessions` finds completed sessions and `traceExistsForSession` provides an idempotency guard for promotion (`src/store.ts:2364-2398`). These are useful primitives, but there is no `proposed` skill state, induction symbol, evidence bundle, or replay-evaluation gate in the inspected module.

**Roadmap overlap check.** The Company Brain already has first-class operating objects/skills (Track E2 heading at `ROADMAP.md:538`) and LC1/LC3 collect outcome-linked retrieval evidence (`ROADMAP.md:1111-1126`). Product roadmap item 4 also insists that observational history cannot justify a choice without paired evals or controlled exploration (`ROADMAP.md:178-202`). This proposal reuses those rules for procedures; it does not replace manual skill creation or LC3 ranking.

**First slice.** Offline, group at least three successful episodes with the same explicit task/lane tag. Produce a non-active `proposed` skill containing normalized steps, trigger, source episode/trace IDs, counterexamples, and an induction-model/version receipt. Run it against a fixed replay manifest with and without the proposal. A human may then activate, revise, or reject it.

**Dependencies.** Structured task/lane identity; closed outcomes and LC1 traces; immutable replay/capsule support or an equivalent pinned manifest; skill review status and audit actions.

**No-go boundary.** Never infer a reusable procedure from one success. Never auto-export or auto-activate generated instructions. Exclude secrets, incidental shell paths, chain-of-thought, and tenant-crossing examples. No fine-tuned controller is required.

**Effort.** 8-12 days after replay receipts and a review state exist.

**Falsifiable gate.** On at least 20 pinned tasks split between matching and non-matching triggers, the proposal must improve the preregistered task verifier versus no-skill, show no statistically meaningful regression on non-matching tasks, introduce no new safety/policy failure, and retain complete episode-to-step provenance. A deliberately misleading successful episode must either be excluded as an outlier or cause the gate to fail.

### 5. Source-reliability priors with calibrated uncertainty

**Gap.** Hippo exposes a categorical confidence label per memory but has no measured, source-conditional reliability estimate or calibration report. Consequently, a frequently retrieved but historically unreliable source can be strengthened without an explicit uncertainty model.

**Exact repository evidence.** `ConfidenceLevel` is the four-value union `verified | observed | inferred | stale` (`src/memory.ts:23`), while `MemoryEntry.source` is a string (`src/memory.ts:63`). `resolveConfidence` returns the stored label or substitutes age-based `stale` (`src/memory.ts:443-454`). Outcome counters and score exist on the entry (`src/memory.ts:52-105`), but the inspected type has no source reliability, sample size, calibration window, or uncertainty interval.

**Roadmap overlap check.** AT2 fixes the conflation of staleness and epistemic tier (`ROADMAP.md:1162-1164`); LC2/LC3 learn memory value and reranking from outcomes (`ROADMAP.md:1115-1126`); the comparative benchmark requires uncertainty around system metrics (`ROADMAP.md:156-176`). Source calibration is a prior/feature derived from source-specific resolved assertions and outcomes, not a replacement confidence tier or another end-to-end reranker.

**First slice.** Produce a read-only calibration report by coarse, privacy-safe source class (for example operator, git, Slack, imported document), with support count, empirical correctness proxy, Brier score/ECE where labels permit, and a shrinkage interval toward the global prior. Expose it in recall explanations but do not rank on it until an ablation passes.

**Dependencies.** Trustworthy labels from assertion CI/corrections; outcome-to-trace linkage; source normalization; minimum-support and drift-window policy; freshness status kept as a separate feature.

**No-go boundary.** No reliability score for individual people in v1. No ranking penalty from tiny samples. No use of popularity as truth, no cross-tenant pooling by default, and no silent override of verified/pinned or policy-required evidence.

**Effort.** 6-9 days for reporting and an offline ablation; production ranking is a separate gated step.

**Falsifiable gate.** On a held-out fixture with intentionally reliable, noisy, drifting, and low-sample source classes, shrinkage estimates must be better calibrated than categorical confidence alone by preregistered Brier/ECE thresholds. If used as an opt-in ranking feature, it must reduce wrong/stale answer rate with confidence intervals excluding zero while meeting useful-recall and minority-source non-regression floors.

## Rejected or deferred variants

- **Rejected as duplicate:** a second generic positive retrieval benchmark. `src/eval-suite.ts` and the comparative benchmark contract already own positive retrieval metrics; item 1 is accepted only as durable operator assertions plus negative/current-value predicates.
- **Rejected as duplicate:** generic context snapshots or compaction summaries. Active snapshots, handoffs/events, LC1 traces, and CS1 already cover continuity. Item 2 is accepted only for immutable decision receipts, deterministic replay, and classified diffs.
- **Deferred:** network revalidators for Slack, GitHub, web pages, and SaaS documents. Prove the contract with local artifacts first; remote checks add credentials, rate limits, deletion semantics, and prompt-injection risk.
- **Rejected:** automatic activation of induced skills. Existing `exportSkills` turns active rows into in-force instructions, so generation must stop at `proposed` until a human and replay gate approve it.
- **Deferred:** production ranking by source reliability. Ship the calibration report and held-out ablation first; otherwise this duplicates LC3 and can suppress truthful minority sources.

## Stale roadmap claims found (not fixed)

1. `ROADMAP.md:1088` says the retrieval/embedder line is "DONE" and further retrieval gains are not the priority, but the newer Product roadmap addition explicitly plans a benchmark-gated entity-aware third retrieval stream (`ROADMAP.md:141-154`). The older absolute statement is stale unless read narrowly as "generic embedder investment is done."
2. `ROADMAP.md:1107` says recall IDs and outcome linkage do not exist on disk, but the same document now marks LC1 retrieval-trace persistence shipped (`ROADMAP.md:1111-1113`), and recent history includes `0b4510d feat: LC1 retrieval-trace persistence (schema v40)`. The dated audit finding is valuable history but stale as a current-state claim.

A related README inconsistency, not a roadmap edit request: `README.md:57` says GitHub ingestion is "next," while the roadmap heading marks E1.4 GitHub ingestion shipped v1.3.0.

## OUTCOME

Created this memo with five bounded, evidence-backed recommendations; each includes overlap, first slice, dependencies, no-go boundary, effort, and a falsifiable gate. No implementation or roadmap changes were made.

## GOAL CHECK

PASS. At most five accepted items; all five candidate gaps were verified in narrowed, non-duplicative forms against exact inspected files/symbols and roadmap sections. Rejected/deferred variants and stale claims are listed separately.

## CONTINUATION CHECK

No continuation is required. Any later planning should choose sequencing, not expand this audit. Suggested dependency order is assertions -> capsules -> local freshness -> reliability report -> human-gated induction.

## TOKEN BUDGET

Bounded-input discipline was used: roadmap headings and requested slices, selected README snippets, package metadata, targeted evidence from five source modules, and the two permitted git receipts. No full-repo crawl, test-suite read, generated output, benchmark output, or diff read was performed.

## WORKTREE RECEIPT

Before this memo, `git status --short` already showed a heavily dirty worktree: `ROADMAP.md`, many `src/` and `tests/` files modified, plus untracked `.devrl-backlog.md`, `.devrl-loop-state.json`, `.oxlintrc.json`, and `tools/oxlint/`. Those pre-existing changes were not inspected or altered. The only write made by this audit is `research/roadmap-deep-research-2026-08-19-internal-v2.md`. No commit or push was performed.

## STOP RULE

STOP. Memo complete. Do not edit `ROADMAP.md`, implement recommendations, modify tests/source/packages/config, commit, push, or write any other file as part of this task.
