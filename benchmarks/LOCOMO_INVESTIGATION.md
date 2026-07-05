# LoCoMo Regression - Evidence Resolved

## Status

**Publishable deterministic baseline: ESTABLISHED 2026-07-05 (v1.25.0,
ROADMAP F7).** Evidence recall@5 = 0.363369 on the same protocol and the
same on-disk data file as the April v0.32/v0.33 runs below (unmodified since
2026-04-22 per mtime; no April sha exists for cryptographic confirmation) —
2.10x the April baseline.
See "Update 2026-07-05" immediately below for the full table, regeneration
commands, determinism characterization, and caveats. Informational only;
gates no feature.

Resolved for the v0.32 vs current regression question: deterministic
gold-evidence recall does not show a meaningful retrieval regression.
Open for quality improvement: absolute LoCoMo evidence recall is still low.
Do NOT carry any framing from the (now closed) LongMemEval thread.

**Correction 2026-07-05 (same day): tag-loss root cause reattributed.**
The "tag-loss finding" published earlier today (below, under "Update
2026-07-05") attributed the loss to hippo's **write path**. That
attribution is wrong. Root cause is the **harness**, not hippo:
`benchmarks/locomo/run.py`'s `run_hippo` used
`shell=(sys.platform == "win32")`. On Windows, `subprocess.run(shell=True)`
builds a `cmd.exe /c <line>` command line, and cmd.exe truncates that line
at the first embedded newline. Every LoCoMo turn whose source text ends
with `"\n"` therefore lost its closing quote and every `--tag` argument
after it -- exit code stayed 0, because the truncated line was still
syntactically valid.

Evidence:

- All 10 conv-41 and both conv-43 tagless rows' SOURCE texts end with a
  trailing newline; their stored content is newline-stripped; healthy rows
  have no trailing newline.
- Deterministic 2-row-store repro, identical content: `shell=True` produces
  a row with only the auto `path:*` tag and a stripped trailing newline;
  `shell=False` produces the full tag set and the newline intact.
- Full-sequence replay: `shell=False` gives 0/663 tagless rows on conv-41;
  `shell=True` (uncontended) reproduces the exact same 10/663 as the
  original run.
- **Hippo exoneration (write-path enumeration, complete).** Exactly one SQL
  statement writes `memories.tags_json` -- `upsertEntryRow`,
  `src/store.ts:992`. Its `ON CONFLICT` branch is unreachable across
  distinct `remember` calls because ids are random 12-hex and collision is
  not something a normal run hits. Both files-to-DB import paths are
  hard-gated: `bootstrapLegacyStore` no-ops on a non-empty DB
  (`store.ts:871-873`); `rebuildIndex` filters to ids not already in the DB
  (`store.ts:1785-1788`). The markdown mirror of an affected row carries
  the SAME stripped tags as the DB row, proving the loss predates
  `writeEntry` entirely. `cli.ts`'s `parseArgs` is positional with no
  content-conditional branching that could drop tags for some inputs and
  not others.

The **measured rates are kept as measurements of the harness bug**, not
deleted: 13 distinct tagless rows / 33 of 9,930 top-5 slots at the
retrieval-sample level, 12/1,343 (0.9%) at the store level (conv-41
10/663, conv-43 2/680) -- see "Tag-loss finding" below, unedited. The
canonical published number is **unaffected**: `score_evidence.py`'s
content-recovery fallback (`content_to_dia`) absorbed tag-less rows in
both the April and July runs, so evidence recall@5 = 0.363369 stands.
The same `shell=True` truncation existed in every April locomo run too
(same `run_hippo` code, same platform).

Fix + regression test + this correction ship together in
`docs/plans/2026-07-05-locomo-harness-newline-fix.md`: a new
`benchmarks/locomo/hippo_subproc.py` helper that never sets `shell=True`
(also refuses `.cmd`/`.bat` HIPPO_BIN shims outright, since batch files
transit `cmd.exe` regardless of the `shell=` argument -- the BatBadBut /
CVE-2024-24576 class -- rather than being individually escapable), wired
into `locomo/run.py` and `locomo/audit_matched_stores.py`. The judge
subprocess calls in `run.py` (`:406` claude judge, `:506` command judge)
are untouched: they pass the prompt via stdin, not argv, so they were
never exposed to this bug.

**Exposure audit** (which scripts pass hippo-bound content via argv vs
stdin vs direct SQLite -- the newline-truncation bug can only fire on the
argv path):

| Site | Content path | Exposed? | Action |
|---|---|---|---|
| `locomo/run.py` `run_hippo` (remember + recall) | content + tags via **argv** | YES (the proven bug) | fixed via `hippo_subproc.py` |
| `locomo/audit_matched_stores.py` `run_hippo` / `remember_turn` | content via **argv**, multi-build `--hippo-cmd` | YES | fixed via `hippo_subproc.py` (explicit `command=` param) |
| `locomo/run.py` judge calls (`:406` claude-cli, `:506` command) | prompt via **stdin** (`input=`), not a hippo call | no | out of scope, documented |
| `longmemeval/ingest.py` (`remember -` content) | content via **stdin** | no | UNEXPOSED, documented only |
| `longmemeval/ingest_direct.py`, `ingest_enriched.py` | direct SQLite `INSERT`, no subprocess for content | no | UNEXPOSED, documented only |
| `longmemeval/retrieve.py` (`recall <query>` argv) | query via argv, but queries are single-line question strings, never turn text | not exposed in practice | documented only, no code change |

No LongMemEval script passes turn content through argv to a shelled-out
hippo call, so no LongMemEval taint follow-up is filed.

Update 2026-07-05: v1.25.0 baseline refresh (F7). ROADMAP F7 said "Never run
before" — that was stale. `benchmarks/locomo/` (`run.py`, `score_evidence.py`)
was run extensively in April 2026; what was missing was a *publishable
current* baseline, since every April judged score was contaminated by judge
failures (see the updates below) and current master had moved from the
v0.32/v0.33 era to v1.25.0 (RRF fusion, graph stream, reranker, scope
filters). This update re-derives the April numbers from disk and adds a
matched v1.25.0 run under the identical protocol. Plan doc:
`docs/plans/2026-07-05-f7-locomo-baseline-refresh.md`.

**Protocol (frozen before the run; identical to April except the binary under
test):** `data/locomo10.json` (10 conversations, 5,882 turns, 1,986 QAs);
`HIPPO_BIN="node <worktree>/bin/hippo.js"` (v1.25.0 @ `f20d9e9`); fresh
`HIPPO_HOME` per conversation; `hippo remember` per turn with
`conv:`/`session:`/`speaker:`/`dia:` tags; `hippo recall --json --budget
4000`, top-k 5; `--score-mode evidence` (deterministic gold-`dia_id` recall,
no LLM judge). Dataset sha256:
`79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4`
(identical between the main-repo original and the worktree copy this run
used; the main-repo file's mtime is 2026-04-22 13:45 — before the April
24-28 runs — so the file has been unmodified since before those runs were
made). No April-recorded sha exists, so byte-identity with what April
actually read is supported by mtime evidence, not cryptographically
confirmed; the sha is recorded going forward for future comparisons.

**Run integrity:** `complete: true`, `failed_conversations: []`, elapsed
93.6 min, 1,982 scored QAs (4 unscored — no gold evidence), 644
`evidence_full`, 176 partial, 1,162 miss.

Regeneration commands (from `benchmarks/locomo/`):

```bash
HIPPO_BIN="node <worktree>/bin/hippo.js" python run.py \
  --data data/locomo10.json --score-mode evidence
# evidence mode auto-names the output results/hippo-v1.25.0-evidence.json
# (the invocation the 2026-07-05 run used; an explicit --output-name must
# include .json, run.py uses the value verbatim)

python score_evidence.py \
  --data data/locomo10.json \
  --result results/hippo-v1.25.0-evidence.json \
  --output results/hippo-v1.25.0-evidence-rescored.json
```

**Results — overall, evidence recall@5 (`score_evidence.py` post-hoc
rescore, canonical):**

| Run | hippo_version in JSON | scored QAs | evidence recall@5 |
|---|---:|---:|---:|
| `hippo-v0.32.0.json` | 0.32.0 | 1,982 | 0.172748 |
| `hippo-v0.34.0-no-salience.json` (filename is stale; JSON records `hippo_version: 0.33.0`) | 0.33.0 | 1,982 | 0.172499 |
| `hippo-v1.25.0-evidence-rescored.json` | 1.25.0 | 1,982 | **0.363369** |

Delta vs v0.32.0: +0.190621 (**2.10x**). Delta vs v0.33.0: +0.190870 (2.11x).

**Per-category (same rescore, canonical numbers):**

| Category | n | v0.32.0 | v0.33.0 | v1.25.0 | v1.25.0 vs v0.32.0 |
|---|---:|---:|---:|---:|---:|
| single-hop | 282 | 0.112781 | 0.121666 | 0.238882 | +0.126101 (2.12x) |
| multi-hop | 321 | 0.204050 | 0.216511 | 0.490914 | +0.286864 (2.41x) |
| temporal-reasoning | 92 | 0.093297 | 0.093297 | 0.169384 | +0.076087 (1.82x) |
| open-domain | 841 | 0.223543 | 0.224732 | 0.450258 | +0.226714 (2.01x) |
| adversarial | 446 | 0.108744 | 0.090807 | 0.226457 | +0.117713 (2.08x) |
| **overall** | 1982 | 0.172748 | 0.172499 | 0.363369 | +0.190621 (2.10x) |

**Two caveats that must travel with the 2.10x number, always:**

1. **Single-run point estimate.** The determinism repeat-check below shows
   run-to-run rank variance among near-duplicate score plateaus large enough
   that the aggregate carries real spread. Treat 0.363369 as a point
   estimate, not an exact value.
2. **Not comparable to vendor LLM-judge numbers.** Mem0/Letta publish
   LLM-as-judge or binary-graded QA accuracy on their own harnesses (table
   below); this is deterministic gold-evidence recall@5 with no judge in the
   loop. The 2.10x is an internal before/after on hippo's own retrieval
   stack, not a claim against Mem0 or Letta.

**Scorer-divergence footnote.** `run.py`'s inline evidence scoring on the
same result file gives 0.362108 (`hippo-v1.25.0-evidence.json`, not
rescored) — 0.001261 below the canonical 0.363369. The divergence is exactly
3 QAs (conv-41 qa_index 79, conv-43 qa_index 15, conv-43 qa_index 58): in
each, one of the top-5 retrieved memories carries no `dia:`-prefixed tag, and
`score_evidence.py`'s `attach_dia_ids` recovers a `dia_id` for that memory via
a content-based lookup (`content_to_dia`) that `run.py`'s inline
`dia_ids_from_memory` does not perform. The April numbers were produced by
`score_evidence.py` with this recovery, so the rescored number (0.363369) is
the one comparable to April — not the inline number.

**Determinism characterization.** No RNG exists in the retrieval code path
(zero `Math.random` in `src/`); within one store, repeated identical recalls
are byte-identical (verified). Across independent runs (fresh ingest each
time, identical build), rankings differ among near-duplicate score plateaus —
the only varying input across identical builds is wall-clock-derived state
(timestamps/ids), which flips ordering among near-tied candidates.
Conversation-1 repeated 4 times (fresh `HIPPO_HOME` each run) gave
mean_score 0.3630, range 0.3401-0.3820, stdev 0.0175 (`det-a.json` ..
`det-d.json`, n=197 QAs each). The 10-conversation aggregate dampens this
considerably — a rough guide (not a formal CI) is stdev/sqrt(10) ≈ 0.006 on
the full-run aggregate. Candidate fix filed in `TODOS.md`: a stable
secondary sort key (e.g. content hash) at score ties.

**Tag-loss finding.** Full recount over the result file
(`hippo-v1.25.0-evidence.json`, all 1,986 QAs x top-5 = 9,930 slots): **13
distinct memory rows** carry no user-supplied
`conv:`/`session:`/`speaker:`/`dia:` tags at all — only the auto `path:*`
tag survives — and those 13 rows surface in **33 of the 9,930 top-5 slots**
(one row recurs in 11 different QAs' top-5; occurrence distribution
11,4,3,3,2,2,2,1,1,1,1,1,1). The divergence-causing subset (tagless AND gold
evidence, hence content-recoverable by `score_evidence.py`) is the 3
instances already cited in the scorer-divergence footnote: conv-41 qa_index
79 `top_k_memories[1]`; conv-43 qa_index 15 `top_k_memories[0]`; conv-43
qa_index 58 `top_k_memories[3]` — those remain valid repro pointers, but
they are the gold-overlapping subset, not the full tagless population.
Store-level spot check (fresh re-ingest of conv-41 + conv-43, comparing row
counts and tag counts against turns ingested): **all turns stored in both
conversations** — conv-41 `turns=663 rows=663`; conv-43 `turns=680
remember_ok=680 rows=680` (no write-time dedupe/merge loss). But a
non-trivial share of rows lost their user-supplied tags entirely: conv-41
`rows_with_dia_tag=653, tagless=10` (10/663, 1.5%); conv-43
`rows_with_dia_tag=678, tagless=2` (2/680, 0.3%) — combined 12/1,343 checked
rows (0.9%) stored with only the auto `path:*` tag, no
`conv:`/`session:`/`speaker:`/`dia:` tags at all. The store-level 0.9% is
the ground-truth rate; the 13 retrieved-unique rows are consistent with it
(retrieved-unique is a lower bound on stored tagless rows for the
conversations involved, since most tagless rows are never retrieved into any
QA's top-5). Same underlying harness bug measured at two sampling depths
(see "Correction 2026-07-05" above -- this is the harness's `shell=True`
newline truncation, not a hippo write-path bug), not conflicting numbers.

**Mem0 / Letta context (not a comparison — different metric, different
harness, never used to gate a feature):**

| System | Metric | Score | Source |
|---|---|---:|---|
| Mem0 (base) | LLM-as-Judge (J), GPT-4o-mini, self-reported | 66.88% ± 0.15% | arXiv:2504.19413 Table 2 |
| Mem0 graph (Mem0^g) | LLM-as-Judge (J), GPT-4o-mini, self-reported | 68.44% ± 0.17% | arXiv:2504.19413 Table 2 |
| Mem0 (2026 blog) | metric unstated in source | "92.5" | mem0.ai/blog/state-of-ai-agent-memory-2026 |
| Letta | binary correct/incorrect, GPT-4o-mini, one-off blog result | 74.0% | letta.com/blog/benchmarking-ai-agent-memory (2025-08-12); no standing leaderboard number (leaderboard.letta.com has no LoCoMo entry as of 2026-07-05) |
| LoCoMo paper's own metric | F1 partial-match; human baseline 87.9% | — | arXiv:2402.17753 §4.1 |

None of these are directly comparable to hippo's evidence recall@5 — they are
LLM-judge or binary-graded QA accuracy on the vendors' own harnesses, not
deterministic gold-passage retrieval. Cross-vendor LoCoMo numbers are
independently known to be unreliable without a shared audited harness: Mem0's
CTO disputed Zep's published 84% claim, recalculating it to 58.44%
(github.com/getzep/zep-papers issues/5); Zep rebutted, alleging Mem0 harness
errors and recalculating to 75.14%
(blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/).

Update 2026-04-27: existing full LoCoMo result files are contaminated by
Claude judge subprocess failures. `run-no-salience.log` contains 1,377
`judge rc=1` warnings, starting in conv-42; conv-44 through conv-50 in
`hippo-v0.34.0-no-salience.json` are all scored `wrong` despite non-empty
top-k memories. `run-v0.32.0.log` also has 528 judge failures. Treat those
published aggregate scores as suspect until rerun with judge failures
aborting rather than scoring as wrong.

Update 2026-04-27 later: matched-store audit passed for all 10 LoCoMo
conversations comparing v0.32.0 vs current: both stored 5,882 / 5,882
expected turns, with zero stored-count delta and zero sampled budget-capped
recall probes. Current judged smoke on conv-26 completed 20 QAs with no
judge failures, but the broader stable 10x20 judged run hit Claude's monthly
usage limit after 140 QAs (`claude -p` now returns "You've hit your org's
monthly usage limit"). Do not treat partial judged JSONs as benchmark scores.

Update 2026-04-27 final: `benchmarks/locomo/run.py` now supports
`--judge-backend claude-cli|openai|command`, stable per-conversation sampling,
and incomplete-run reporting. The 140-QA stable partial current run is useful
for miss analysis only. Main miss patterns: temporal anchoring misses,
recurring-topic distractors, photo/image evidence gaps, weak list aggregation,
and unsupported profile/inference questions.

Update 2026-04-28: Claude CLI quota recovered, but repeat judged runs still
failed with transient `judge rc=1`, and same-conversation scores moved by
about 0.03 across runs. The LLM judge is too noisy for the v0.32 vs current
question. Added deterministic evidence scoring:

```bash
python benchmarks/locomo/score_evidence.py \
  --data benchmarks/locomo/data/locomo10.json \
  --result benchmarks/locomo/results/hippo-v0.32.0.json \
  --output benchmarks/locomo/results/hippo-v0.32.0-evidence.json

python benchmarks/locomo/score_evidence.py \
  --data benchmarks/locomo/data/locomo10.json \
  --result benchmarks/locomo/results/hippo-v0.34.0-no-salience.json \
  --output benchmarks/locomo/results/hippo-v0.34.0-no-salience-evidence.json
```

Full-file deterministic rescore, top-k evidence recall@5:

| Run | hippo_version in JSON | scored QAs | evidence recall@5 |
|---|---:|---:|---:|
| `hippo-v0.32.0.json` | 0.32.0 | 1,982 | **0.172748** |
| `hippo-v0.34.0-no-salience.json` | 0.33.0 | 1,982 | **0.172499** |

Delta = -0.000249, effectively zero. Row-level, current is better on 62 QAs,
worse on 62 QAs, and unchanged on 1,858 scored QAs. Four QAs have no gold
evidence and are unscored. Conclusion: the apparent judged gap was a judge
failure/noise artifact, not a v0.32-to-current retrieval regression.

## What we know so far

| Run | Code | Salience | mean_score | n_equivalent / 1986 |
|---|---|---|---|---|
| 2026-04-24 v0.32.0 | tag `v0.32.0` | n/a (didn't exist) | **0.279** | 429 |
| 2026-04-24 v0.34 pineal-salience-on | working tree | force-on | **0.020** | 23 |
| 2026-04-25 v0.34 salience-off | working tree | default off | **0.139** | 205 |

Those judged scores are now known to be contaminated by judge failures. The
deterministic evidence rescore says salience-off/current and v0.32 retrieve
gold evidence at the same rate. Two separate things remain:

1. The salience contribution itself (0.139 vs 0.020 = ~7x) is the
   biggest single signal so far. Mechanism: write-time lexical-overlap
   gate drops same-conversation continuation turns, which is most of
   LoCoMo by construction.
2. Absolute evidence recall is low (~17.3% recall@5), especially temporal
   and adversarial categories. That is the next LoCoMo improvement target.

## Things that are NOT yet known and must be re-verified

- Were the v0.32 and v0.34 stores built from the same corpus the same
  way, or are there ingest-path / consolidation differences?
- Was the same retrieval harness used for both runs? (`benchmarks/locomo/run.py`
  shells out per QA, similar to `retrieve.py` on LongMemEval. Check whether
  budget/min-results choices are equivalent across the runs being compared.)
- Per-conversation isolation: LoCoMo creates a fresh HIPPO_HOME per
  conversation. Verify that's identical across runs.

## Repro Plan

1. Build matched stores for v0.32.0 (or whichever known-good tag) and
   the current v0.34 working tree, both with `--no-hooks --no-schedule
   --no-learn` init, both with salience off, both via whatever ingest
   path each version supports cleanly.
2. Confirm memory counts and per-conversation distributions match. Use
   `benchmarks/locomo/audit_matched_stores.py` for the first cheap pass:
   it builds fresh temp stores, exports counts, and probes configured vs
   high-budget recall without running the Claude judge. Use `--max-turns`
   only for smoke checks; omit it for real matched-store parity.
3. Run `benchmarks/locomo/run.py` on each with identical flags. Keep the
   recall preflight enabled: it compares the configured `--budget` against
   a high-budget probe before judging and aborts if top-k recall is capped.
   If it fails, raise `--budget` before scoring.
4. Prefer deterministic evidence scoring for regression checks:
   `python benchmarks/locomo/score_evidence.py --data benchmarks/locomo/data/locomo10.json --result <json> --output <json>`.
   Use LLM judges only for answer-quality reporting, not regression triage.
5. If a future regression survives matched stores + deterministic evidence
   scoring, then bisect. Not before.

## Hard rules

- Do not enable salience.
- Do not skip step 1 (matched stores).
- Do not run anything until step 3's harness is sanity-checked the same
  way LongMemEval was — half a day was burned on a `retrieve.py` /
  budget-4000 artifact there. Same trap likely applies here.
- If a regression survives matched stores + matched harness + deterministic
  evidence scoring, then bisect.
  Not before.
