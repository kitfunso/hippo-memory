# LC2-E3: Learned memory-value wiring into sleep decay (opt-in, default off)

Status: Draft (not yet engineering-reviewed)
Episode: 01KZP10K2DNX13DWDGB62G63DV
Date: 2026-08-10
Predecessors: LC2-E1 (PR #138, eval substrate), LC2-E2 (PR #140, learned weights, BARS MET)

## Goal

Wire the frozen learned memory-value scorer (`benchmarks/memory-value/weights-learned.json`,
sha256 `1e747abed0df771fc9c354da8562771b336c4042faf0266f565bba1b5a8c5a40`) into the
sleep decay pass (`src/consolidate.ts`) behind an opt-in config flag, **default off**.
First `src/` change of the LC2 track.

## Non-goals

- No default flip. The flag ships off and stays off; flipping is a dogfood/LC3-era decision.
- No CLI surface (`hippo value` etc.) — scope creep; sleep `--dry-run` detail lines suffice.
- No refit, no weight changes, no new eval protocol. The artifact is consumed as frozen.
- No tombstones (AT1 is its own roadmap item). No DB schema migration.
- No LC3 rerank work (retrieval stays untouched).

## Binding constraints (carried from brainstorm + guards)

1. **Salience precedent** (`feedback_hippo_salience_regression`, recall 81→15): ships ONLY
   behind pre-registered gates per `docs/RETRACTION.md` discipline. Prereg doc locks before
   any gate run.
2. **Default-off = byte-identical.** Flag off, the new code path is unreachable and decay
   decisions are bit-identical to master. Test-proven, not asserted.
3. **Additive public API.** `consolidate()` is exported (`index.ts`) and called from
   `api.ts`/`cli.ts` — signature stays additive-optional (no required-param changes).
4. **Caveat rides the artifact** (from the E2 result doc, verbatim in README + code comment):
   usage-feature signs reflect E1's anti-oracle simulation, NOT real usage value. Never
   read as production ranking advice; LC3 tests real usage value.
5. **Fail loud, never fall back** (`feedback_fallbacks_absent_not_broken`): flag enabled +
   weights constant malformed/dim-mismatched → throw at sleep start. Never silently
   behave as flag-off.

## Design decisions (the three carried brainstorm concerns, resolved)

### D1. Rescue-only semantics (resolves demote-vs-delete AND the usage-sign hazard)

Flag on, the learned score acts as a **rescue veto on the existing forget set**:

- Condemnation trigger unchanged: `!pinned && calculateStrength(entry, now, decayOpts) < 0.05`.
- For each condemned entry, compute its learned-score rank within its own tenant's
  non-pinned candidate set (per-tenant grouping — see D2).
- **Rescue** iff the entry ranks in the top 30% of its tenant by learned score — the E2
  keep-budget operating point, the only point with measured evidence. Rescued entries are
  kept exactly as-is (no writes, no half-life edits); non-rescued condemned entries follow
  the existing delete path.
- Every rescue emits a `result.details` line AND an audit row (attributability).

Properties this buys, by construction:
- **Deletes(flag-on) ⊆ Deletes(flag-off).** The scorer can only rescue, never condemn.
  The catastrophic misread of the usage-sign artifact (deleting your most-retrieved
  memories) is structurally impossible.
- Idempotent per sleep: a rescued entry is re-evaluated next sleep; no state churn.
- Pinned exemption unchanged (pinned entries are never condemned, so never scored for rescue).

**Rejected alternative (recorded):** budget-rank forgetting (forget bottom X% by learned
score per sleep). E1's keep budget was a one-shot eval construct; applied per-sleep it
compounds — repeated sleeps delete X% every pass regardless of store health (runaway).

### D2. Rank-based scoring, normalized and ranked PER TENANT (resolves threshold-vs-budget + the context-mismatch finding)

The E2 weights were fit on min-max normalized features per store (evaluate.mjs; a constant
feature normalizes to 0), where each fit-time "store" was a bounded per-question scratch
root. Production `consolidate` loads entries **host-wide across tenants** (round-1 critic
finding), and min-max is composition-sensitive — so the rescue context must be bounded,
not host-wide. Resolution: **group non-pinned entries by `tenantId`; normalize and rank
within the tenant**. A memory competes for rescue only against its own tenant's memories.
This is the closest production analog to the bounded fit-time context, and it buys a
testable isolation property: an entry's rescue outcome cannot change when another tenant's
composition changes.

Honest claim-scoping (pre-registered, not post-hoc): the E2 numbers validate the scorer's
ranking in bounded eval stores. Production-scale rank behavior is **characterized** (G4:
property-gated, rescue rate reported) — not claimed as validated by E2. The instrument for
any future flag-flip decision is dogfood evidence via the rescue audit rows, plus the full
LongMemEval + micro-eval battery (pre-registered as the flip's precondition).

The threshold remains the condemnation trigger; the E2 budget (0.30) becomes the
per-tenant rescue criterion. Absolute score cutoffs are meaningless under min-max — rank
is the only valid reading, and D1's rescue rule is pure rank.

### D3. Weights embedded as a generated src constant

`benchmarks/` does not ship in the npm tarball (`package.json` `files`). The frozen vector
is embedded as `src/memory-value-weights.ts`: the 8 named weights, the source-artifact
sha256, and a generated-from header. Track L Rule 2 (derived, rebuildable, git-diffable)
holds: a sync test asserts the constant equals the committed JSON artifact (value equality
+ digest match), so drift between artifact and constant fails CI.

## Tasks

- **T1 — `src/memory-value.ts`** (new, ~120 lines): `computeMvFeatures(entry, now)`
  mirroring `benchmarks/memory-value/extract.mjs` `computeFeatures` for the 8 live dims
  (age_days, half_life_days, strength, retrieval_count, outcome_positive,
  outcome_negative, outcome_ratio with the `(pos-neg)/(pos+neg+1)` formula,
  content_length). **The strength FEATURE is clock-basis `calculateStrength(entry, now)`
  with NO DecayOptions** — that is how the frozen weights' training features were
  computed; passing the production decay basis into the feature would silently break
  parity (round-1 finding). The condemnation TRIGGER keeps using `decayOpts` as today;
  the intentional divergence is documented in code. Consequently `scoreEntries(entries,
  now)` and `rescueSet(entries, condemnedIds, now)` take **no decayOpts parameter**.
  `rescueSet` groups by `tenantId` internally (D2), applies the fixed 0.30 budget per
  tenant, and **returns `Set<string>` of rescued entry ids** (the caller filters commits
  and threads the same set into `detectConflicts`). Validates the weights constant at
  entry (8 finite values, digest present) — throw on mismatch (constraint 5).
- **T2 — config key** `memoryValue: { enabled: false }` at ALL THREE config.ts sites
  (interface ~:86, DEFAULT_CONFIG ~:147, merge line ~:187). No other knobs in v1 — the
  rescue budget is a code constant tied to E2 evidence, not user-tunable.
- **T3 — decay-pass wiring** in `src/consolidate.ts`. Flag ON restructures the decay pass
  into two phases (round-1 finding — the current loop commits condemned entries inline):
  **phase 1** classifies every entry (condemned vs survivor) with zero commits; **phase 2**
  runs `rescueSet` over the per-tenant groups, then commits: rescued entries are pushed to
  `survivors` (full participation in this cycle's merge pass, physics, and conflict
  detection — they are kept, so they must behave as kept); non-rescued condemned entries
  follow the existing `pendingDeletes`/`result.removed`/`result.details` path. Flag OFF
  takes the existing single-phase loop untouched (byte-identical). **Dry-run: the rescue
  computation RUNS under `--dry-run`** (pure compute; only `pendingDeletes` stays gated on
  `!dryRun`, the existing pattern) so the preview matches what a real run would do; rescued
  entries get their own detail line. **`detectConflicts` participation (round-2 finding):**
  `detectConflicts` (consolidate.ts:592-598) independently recomputes
  `calculateStrength >= DECAY_THRESHOLD` as its own survivor filter, which would silently
  re-exclude rescued entries every cycle. It gains an optional `rescuedIds:
  Set<string>` parameter (default empty — flag-off behavior unchanged) whose members
  bypass that internal strength filter, so rescued entries genuinely participate in
  conflict detection. Audit sites, all three enumerated (v1.11.5 CRIT A lockstep rule):
  `AuditOp` union (src/audit.ts:130) gains `'mv_rescue'`; `VALID_AUDIT_OPS` in
  src/cli.ts:7258 AND src/server.ts:168 gain it in lockstep. One audit row per rescue
  with entry id + tenant + rank context.
- **T4 — tests** (`tests/memory-value-wiring.test.ts`, real stores per house rule):
  (a) **feature parity**: same synthetic store → `computeMvFeatures` vs the benchmark
  `computeFeatures` (direct .mjs import) → identical 8-dim vectors;
  (b) **normalization parity** vs evaluate.mjs min-max on a fixture;
  (c) **weights-sync**: constant === JSON artifact values + digest;
  (d) **flag-off byte-identical**: cloned store, sleep with flag off vs master semantics →
  identical survivor sets, zero mv audit rows;
  (e) **rescue semantics**: constructed condemned entries with high/low learned rank →
  rescued/deleted respectively; deletes-subset property; audit rows present; rescued
  entries participate in the same cycle's merge pass (survivors re-entry) AND conflict
  detection (rescuedIds bypass);
  (f) **pinned exemption** unchanged; (g) **fail-loud**: enabled + corrupted constant → throws;
  (h) **scale characterization**: synthetic ~2,000-entry store across 3 tenants with
  spanned feature ranges → flag-on sleep is deterministic, subset property holds,
  **per-tenant isolation**: an entry's rescue outcome is unchanged when another tenant's
  composition changes; rescue rate reported (characterized, not gated). Entries use
  varied content and non-episodic layers where possible so the pre-existing O(N²) merge
  pass does not dominate the vitest runtime;
  (i) **dry-run parity**: dry-run preview decisions == real-run decisions on a cloned store.
- **T5 — docs**: README config section (with the verbatim caveat), ROADMAP LC2 status
  update, prereg + result docs under `docs/evals/`.

## Pre-registered gates (locked in `docs/evals/2026-08-10-lc2-e3-wiring-prereg.md` BEFORE any gate run)

- **G1 — code parity (scoped honestly):** the E1 retention harness, driven through the
  **src-side scorer** (thin eval-only adapter in `benchmarks/memory-value/`), reproduces
  the registered E2 held-out numbers: weighted 0.48973684 at keep 0.30, epsilon 5e-5.
  This proves the src feature extraction + normalization + scoring are byte-equivalent to
  the fit-time path in the fit-time context. It does NOT validate production-scale rank
  behavior — that is G4's characterization plus the pre-registered flag-flip battery.
- **G2 — default-path non-regression:** full vitest suite green; test (d) proves flag-off
  bit-identity. The 77-minute LongMemEval run is NOT re-run for the off path — the off
  path is unreachable code plus a bit-identity test, and re-running adds no information;
  this justification is pre-registered, not post-hoc. (Roadmap's LongMemEval gate was
  written for constants-replacement, which would have changed default behavior; rescue-only
  + default-off supersedes it for E3. The flag-flip decision, whenever it comes, re-triggers
  the full LongMemEval + micro-eval battery — that requirement is pre-registered here.)
- **G3 — behavioral properties:** tests (e)/(f)/(g)/(i) green (deletes-subset, pinned,
  fail-loud, dry-run parity).
- **G4 — scale characterization:** test (h) properties green (determinism, subset,
  per-tenant isolation) at ~2,000 entries / 3 tenants; rescue rate REPORTED in the result
  doc, explicitly not gated — production-scale rank behavior is characterized, not claimed
  as E2-validated. The future flag-flip's preconditions (dogfood evidence via rescue audit
  rows + full LongMemEval + micro-eval battery) are pre-registered here.

## Risks

- **Extractor drift** (src mirror vs benchmark): closed by parity test (a) — any future
  edit to either side breaks CI.
- **Performance**: scoring is O(N·8) + a sort per sleep, only when flag on AND the
  condemned set is non-empty. Negligible against the existing O(N²) merge pass.
- **Tenant/store scoping**: `consolidate` is host-wide across tenants within one
  hippoRoot (L9 comment, consolidate.ts:128-131) — that is exactly why D2 normalizes and
  ranks per tenant. No cross-hippoRoot surface exists; cross-tenant rank influence is
  closed by the per-tenant grouping and proven by the T4(h) isolation property.
- **Churn**: rescued entries stay condemned-eligible next sleep — by design, idempotent,
  no writes.

## Success criteria (falsifiable)

1. All T4 tests green in the worktree AND in CI.
2. G1 reproduces the registered E2 held-out retention through the src scorer at 4dp intent.
3. Flag-off bit-identity proven by test, not asserted.
4. Every rescue attributable: audit row with entry id + score rank context.
5. Version bump minor; ships through the full release chain (corrected ship-it directive).
