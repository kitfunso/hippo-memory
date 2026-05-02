# Company Brain Measurement-First Plan

Date: 2026-04-28
Status: proposed
Owner: main

## Question

How will Hippo tell whether a new Company Brain feature adds value before rolling it out?

## Answer

Treat every feature as a falsifiable bet.

A feature only counts as progress when all three conditions hold:

1. it improves one named primary outcome against a baseline or feature-off comparator
2. it does not regress the existing retrieval and learning guardrails
3. the evidence is file-backed and repeatable from the repo

That means no Company Brain work should start with "this seems useful". It should start with:

- the behaviour we expect to improve
- the exact harness that will measure it
- the baseline condition
- the pass/fail threshold

## Current Repo Grounding

Hippo already has most of the measurement pieces, just not one Company Brain scorecard.

### Existing measurable surfaces

- Retrieval quality: `hippo eval <corpus.json>` via `src/eval.ts` and `evals/README.md`
- Built-in feature regression suite: `hippo eval --suite` via `src/eval-suite.ts`
- Sequential task improvement: `tests/agent-eval.test.ts`
- Continuity primitives: `tests/store.test.ts`, `tests/pr2-session-continuity.test.ts`
- Current-vs-historical truth: `tests/cli-supersede.test.ts`, `tests/bi-temporal-recall.test.ts`
- Context assembly signals: `src/cli.ts` already emits `activeSnapshot`, `recentSessionEvents`, `memories`, and `tokens` in JSON mode

### What is missing

- A continuity scorecard that answers "can a fresh agent resume the current task cheaply and correctly?"
- A provenance coverage score once Company Brain receipts gain first-class `owner` and `artifact_ref` fields
- Instrumentation for correction latency from "fact changed" to "current truth updated"

## Scorecard

| Outcome | Why it matters | Comparator | Harness now | Ship gate | Status |
|---|---|---|---|---|---|
| Current-truth precision | Company Brain must surface what is true now, not stale contradictions | feature-off / before change | bi-temporal tests plus recall/context behaviour | no regression in default current-only behaviour | measurable now |
| Retrieval quality | Company Brain features must not quietly make core recall worse | baseline corpus / saved baseline | `hippo eval evals/real-corpus.json`, `hippo eval --suite` | no regression in MRR or NDCG on the relevant corpus | measurable now |
| Sequential learning | Features should help agents avoid repeated mistakes over time | no-memory + static-memory conditions | `tests/agent-eval.test.ts` | no drop in Hippo late-phase trap avoidance | measurable now |
| Active-task resume coverage | Fresh sessions should receive task, summary, next step, handoff, and recent trail without transcript replay | continuity objects absent vs present | `tests/company-brain-scorecard.test.ts` | feature-on coverage must beat baseline and reach full required-signal coverage in the synthetic case | measurable now with a small scaffold |
| Orientation-token reduction | Distilled continuity context should be cheaper than replaying raw session text | raw event transcript vs distilled packet | `tests/company-brain-scorecard.test.ts` using `estimateTokens()` | distilled packet under 45% of raw transcript tokens in the synthetic case | measurable now with a small scaffold |
| Stale-memory rate | Current context should not pull dead knowledge unless asked | before/after feature change | stale-confidence lifecycle tests plus targeted recall cases | no increase in stale current-truth leakage | partly measurable now |
| Provenance coverage | Enterprise memory must answer who said what, when, and from where | before/after provenance feature | `hippo provenance [--json] [--strict]` (src/provenance-coverage.ts), unit + CLI tests in `tests/company-brain-scorecard.test.ts` and `tests/provenance-cli.test.ts` | 100% of `kind='raw'` rows carry `owner` and `artifact_ref`; `--strict` exits non-zero on gaps for CI | measurable now |
| Correction latency | Enterprise truth should update quickly when facts change | before/after correction flow | `hippo correction-latency [--json]` (src/correction-latency.ts), unit + CLI tests in `tests/company-brain-scorecard.test.ts` and `tests/correction-latency-cli.test.ts` | extraction-driven p50/p95/max from receipt to supersession; manual-only stores flagged so the metric isn't silently zero | measurable now |

## Feature Evaluation Contract

Every Company Brain feature proposal should include this before implementation:

1. **Primary outcome**
   - Pick one row from the scorecard above.
   - Name the exact metric, not a theme.

2. **Comparator**
   - One of:
   - feature off vs feature on
   - before vs after on the same corpus
   - Hippo vs no-memory / static-memory condition

3. **Evidence path**
   - Name the file or command that proves the outcome.
   - Save the output to disk if the command is noisy.

4. **Guardrails**
   - Run `hippo eval --suite` for feature-level regressions when the change touches search or context assembly.
   - Run the relevant targeted tests for continuity or current-truth behaviour.

5. **Decision rule**
   - Ship: primary metric clears threshold and guardrails stay green
   - Hold: result is flat or ambiguous
   - Cut: primary metric regresses or guardrails fail

## First Implementation Order

### 1. Land the continuity scorecard scaffold now

Reason:

- the repo already has snapshots, session events, handoffs, and token estimation
- continuity is the clearest Company Brain edge Hippo already owns
- current tests prove persistence, but not value versus a baseline

This tranche lands only the scaffold, not the product feature.

### 2. First real product slice next: continuity-first context assembly

Implement next, after the scaffold is in place:

- surface the latest matching handoff alongside the active snapshot and recent session trail in the default resume path
- keep the hot path cheap and local
- measure success with the continuity scorecard and retrieval guardrails

Why this is first:

- it builds on primitives Hippo already has
- it targets the product metric the repo is best prepared to measure now
- it strengthens the Company Brain story without forcing ingestion, tenancy, or graph work first

### 3. Only then add the canonical provenance envelope

This is the next important Company Brain gap, but it should follow continuity:

- raw receipts need first-class `owner`, `artifact_ref`, and `kind`
- provenance coverage is not measurable cleanly until those fields exist

Do not start there first. It adds schema and migration cost before the repo has a continuity scorecard.

## Verification For This Planning Tranche

If the scaffold lands:

```powershell
node .\node_modules\vitest\vitest.mjs run tests/company-brain-scorecard.test.ts
npm test
npm run build
```

Known baseline issue:

- `npm test` is already red in the clean worktree because `tests/cli-supersede.test.ts` and `tests/bi-temporal-recall.test.ts` time out in `cmd.exe`

That failure should be reported, not mistaken for regression from this tranche.
