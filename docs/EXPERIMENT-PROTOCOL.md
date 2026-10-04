# Experiment Protocol — Jev durability vs hippo's own labels

Pre-registered 2026-09-18, **before the first scoring call**. One decision
experiment, not a campaign. Instantiated from `/quant-ml-protocol` Stage 0.

## 0. The decision this gates

Whether to replace hippo's flat `schema_fit = 0.5` default (`src/memory.ts:520`)
with TypeSafe Jev's calibrated durability probability at write time.

`schema_fit` is not cosmetic: `deriveHalfLife` reads it, and `src/memory.ts:399-404`
extends half-life above 0.7 and shortens it below 0.3. Today 694 of 1941 stored
memories sit on the constant 0.5, so that branch is dead code for a third of the
store. The claim under test is that Jev can fill it with a number that carries
signal.

## 1. Sample-size math (done first, as required)

- Population: 1941 rows in `~/.hippo/hippo.db`, `kind != 'archived'`, content > 20 chars.
- Draw: **n = 250**, uniform random, single draw, seed recorded in the result JSON.
- Expected split at the useful-label rate observed in the full store
  (retrieved 3+ = 1059/1941, outcome_positive = 543, pinned = 11):
  roughly n_pos ≈ 150, n_neg ≈ 100.
- SE(AUC) ≈ sqrt(A(1-A)/min(n_pos, n_neg)) ≈ **0.035** at A ≈ 0.6.
- **Detectable-effect floor: 0.07 AUC at 2 SE.** Any gap smaller than this,
  against chance or against a baseline, is inside the noise bar and is reported
  as a flag, never as a result.
- Cost: 250 calls x $0.0004 = **$0.10**.

## 2. Instrument mechanics (what the label actually is)

Label `useful = retrieval_count >= 3 OR outcome_positive > 0 OR pinned = 1`.

This is hippo's own revealed preference, not a hand-labelled set. Three known
defects in it, declared now rather than discovered later:

1. **Age confound.** An older memory has had more chances to be retrieved.
   Mitigation: report the age-normalised label (retrievals per day alive) as a
   second lane. If the two lanes disagree, the raw lane is the diagnostic and
   the normalised lane is the verdict.
2. **Injection confound.** The `hippo context` hook injects pinned memories every
   prompt, so `pinned` partly causes `retrieval_count` rather than validating it.
   Mitigation: `pinned` is n = 11, too thin to matter; report it separately and
   never let it carry the verdict.
3. **Recall is not usefulness.** A memory retrieved often may be retrieved and
   ignored. `outcome_positive` is the closer proxy and is reported on its own row.

## 3. Baselines before models (Stage 3 — the bar Jev must clear)

Jev vs chance is **not** the test. Every baseline below is free, already in the
row, and must be beaten:

| Baseline | Why it is the honest bar |
|---|---|
| `content_length` | Longer memories may simply match more queries |
| `source == 'cli'` | Hand-written memories are durable by construction |
| current `schema_fit` | The incumbent the change would replace |
| coin flip | Chance floor |

**Primary metric:** AUC of Jev `durable` vs `useful`, reported beside the AUC of
every baseline, each with a bootstrap interval, plus the **paired** Jev-minus-
best-baseline delta with its own interval.

**Decision rule (declared, and attackable):**

> SHIP the wiring only if Jev's AUC beats the best single baseline by more than
> 0.07 (the noise floor in §1) with a paired bootstrap interval excluding zero.
> A tie promotes the incumbent — the flat 0.5 — by parsimony, because the
> incumbent costs no money, no latency and no outbound HTTP.

**This verdict is only as good as this rule. Attack the rule, not just the numbers.**

## 4. Trial ledger

| N | Lane | Status |
|---|---|---|
| 1 | Jev `durable` vs `useful`, raw label | declared 2026-09-18 |
| 2 | Jev `durable` vs `useful`, age-normalised label | declared 2026-09-18 |

N = 2 verdict lanes. At alpha = 0.05, expected false passes = 0.1. Any third lane
invented after seeing results is a diagnostic and is labelled as one.

## 5. NOT-DONE (declared, not silently skipped)

- **Selection-honest holdout.** Not run: there is no model being fitted here, no
  hyperparameter is chosen from this data, so there is nothing to overfit. If a
  threshold on `durable` is later tuned, that tuning needs its own holdout.
- **Process null (time-shifted replay).** Not run: no search is being performed,
  so there is no search-induced optimism to null out. Required before any lane
  that tunes a cutoff.
- **Paired A/B on retrieval quality.** Not run in this experiment, and it is the
  real gate for shipping. This experiment only establishes whether the signal
  exists at all. Wiring `schema_fit` changes half-life, which changes what
  survives decay, which is a retrieval-quality question that LongMemEval must
  answer. Pre-registered as the next stage, gated on this one passing.
- **Cost/latency in production.** Jev is ~0.4s per call. Capture is off the
  latency path; `hippo context` is not. This experiment does not license wiring
  Jev into recall.

## 6. Binding precedent

ROADMAP C1: the salience gate dropped recall 81 -> 15 when enabled
(`feedback_hippo_salience_regression`, do-not-re-enable). That regression came
from a gate that suppressed what entered the store. The wiring this experiment
gates must therefore be **score-only**: it may set `schema_fit`, it must never
block a capture. Any proposal that turns this score into a gate re-opens C1 and
needs its own protocol.

---

# RESULT — run 2026-09-18

Raw output: `results/jev-store-score-2026-09-18.json`. 407 live Jev calls,
0 failures, $0.163 total, 736ms median latency.

## Verdict: DO NOT SHIP. Both pre-registered lanes FAIL.

| Lane | Jev AUC | Best baseline | Delta | 95% CI | Rule |
|---|---|---|---|---|---|
| 1. useful (raw), n=250 | 0.511 | schema_fit 0.552 | -0.041 | [-0.152, 0.075] | FAIL |
| 2. useful (age-normalised), n=250 | 0.557 | content length 0.549 | +0.008 | [-0.059, 0.083] | FAIL |

Jev's durability probability is at chance for predicting which stored memories
hippo actually uses. The declared rule says a tie promotes the incumbent, and
this is not even a tie.

## Diagnostic (NOT a verdict lane — invented after seeing lane 1+2)

Capture-only population, n=157, every row on the flat `schema_fit` 0.5:

| Scorer | AUC vs useful (raw) |
|---|---|
| content length | **0.655** |
| Jev durable | 0.534 |
| coin flip | 0.468 |

Jev minus content length = **-0.122, CI [-0.241, -0.008]**. The interval excludes
zero in the *wrong* direction: on the population the wiring actually targets,
counting characters beats the hosted decision model, significantly.

## Stage 5.6 self-audit — what else is wrong with what I did

**Data.** The `useful` label conflates three things (recall frequency, outcome
feedback, manual pinning) that the store records at very different densities
(1578 / 543 / 11 rows). Reported separately; `pinned` was too thin to carry weight.
Checked and clean: `retrieval_count` is not an age counter (corr with age_days
= 0.286, range 0..2205), so the label has real structure. Nothing else scored
above chance on it either, which is a fact about the task, not about Jev alone.

**Statistics.** n=250 gives SE(AUC) ~0.035, so the 0.07 floor is 2 SE and lane 2's
+0.008 is comfortably inside noise. The bootstrap resamples rows, not
(positive, negative) pairs, so the AUC intervals are slightly optimistic. It does
not change a FAIL.

**Code.** Real defect found in my own design: the `durable` prompt asserts "this
text was extracted from an AI coding agent transcript", but lanes 1 and 2 sampled
all sources, of which only 157/1917 are regex captures. The prompt and the
population disagreed. The diagnostic lane corrects that mismatch and Jev gets
*worse*, so the mismatch was not hiding a win.

**Process.** The baseline set (Stage 3) is what produced the verdict. Scored
against chance alone, Jev's 0.534 on the capture lane would have read as a pass
and shipped. A single after-the-fact lane was run; it is labelled a diagnostic
and cannot overturn the pre-registered result.

## What this does and does not close

- **Closed:** Jev's durability score as a replacement for `schema_fit`. Dead on
  this evidence. Reopening needs a new pre-registration and a different label.
- **Not tested:** Jev's *classification* output (kind, valence). It looked sane by
  eye on capture rows (convention 59, error 57, trivia 14 of 157) but was never
  scored against a label, because hippo stores no ground-truth category to score
  it against. That is a separate experiment and a separate build.
- **Not a bug:** the content-length effect. `src/search.ts:54-94` implements BM25
  length normalisation correctly (b=0.75), so longer memories winning recall is
  surface area, not a scoring defect.
- **Standing:** `src/judgment.ts` ships behind `TYPESAFE_API_KEY` with no call site
  in `src/`. Zero outbound HTTP without the key; the README invariant holds.

---

# Lane 3 — pre-registered 2026-09-18, BEFORE the first call

Lane 1+2 tested Jev's *durability* score and it failed. This lane tests the half
I declared "not tested": Jev's **classification** output. It is a separate
pre-registration with its own decision rule, not a re-run of a failed lane.

## The decision this gates

Whether Jev can recover hippo's `error` tag from content alone. That tag is not
cosmetic: error memories get sticky half-lives, and today the tag only exists
when a human typed `hippo remember --error`. Auto-captured and git-learned rows
never get it. If Jev can apply it from content, the sticky-error physics starts
working on the 1,600+ rows that never passed through a human's `--error` flag.

## Why this label is worth scoring (checked before spending)

- Ground truth: `error` in `tags_json`, n = 1066 of 1917 eligible rows, base rate **0.556**.
- The obvious free baseline already FAILS: a keyword regex over
  error|fail|wrong|broke|gotcha|bug|crash|never|cannot scores accuracy 0.412,
  precision 0.453, recall 0.280, **MCC -0.150**. It is worse than chance, so the
  label is semantic rather than lexical. This is the gap Jev is supposed to fill.
- `emotional_valence` is EXCLUDED as a baseline: it is negative for exactly 1071
  rows and error-tagged for exactly 1071 rows. It is the same label, not a predictor.

## Sample-size math

- Draw: **n = 400**, uniform random, seed recorded. Expected 222 pos / 178 neg.
- SE(AUC) = sqrt(0.25/178) = **0.037**. Detectable-effect floor **0.075** at 2 SE.
- Cost: 400 x $0.0004 = **$0.16**.

## Baselines before models (Stage 3)

| Baseline | Kind | Bar or ceiling |
|---|---|---|
| keyword regex | content-only | bar Jev must clear |
| content length | content-only | bar Jev must clear |
| coin flip | content-only | bar Jev must clear |
| coarse source prior | METADATA | reported as a leakage ceiling, NOT a bar |

The source prior is not a fair bar: source family predicts the tag strongly
(shared 0.75, claude-memory 0.00, capture 0.22) but it is provenance metadata
that Jev never sees. It is reported so the reader knows how much of this label
is explained by where the row came from rather than what it says.

## Decision rule (declared, and attackable)

> SHIP the tagger only if Jev's AUC beats the best CONTENT-ONLY baseline by more
> than 0.075 with a paired bootstrap interval excluding zero, AND the hard
> `kind == 'error'` choice beats the keyword regex on MCC. A tie promotes the
> incumbent, which is "no tag unless a human typed --error".

**This verdict is only as good as this rule. Attack the rule, not just the numbers.**

## Declared confound

The `shared:` import batch is 1127 of 1917 rows at p(error) 0.75. A model that
merely detects "this is from the 2026-04 import" would score well. Mitigation:
the within-source AUC is reported for `shared` and `cli` separately. If the
overall AUC holds but both within-source AUCs collapse to chance, the verdict is
FAIL regardless of the headline number.

## Trial ledger

| N | Lane | Status |
|---|---|---|
| 1 | Jev durable vs useful, raw | RUN, FAIL |
| 2 | Jev durable vs useful, age-normalised | RUN, FAIL |
| 3 | Jev isError vs the error tag | declared 2026-09-18 |

N = 3 verdict lanes. At alpha = 0.05, expected false passes = 0.15.

---

# Lane 4 — pre-registered 2026-09-18, BEFORE the confirmatory call

## Why this lane exists

Lane 3's declared confound check showed Jev at AUC 0.884 on `source = 'cli'`
rows (n = 61) against 0.510 on capture rows and 0.640 on the shared import.
That observation is POST-HOC and cannot be a verdict. This lane converts it
into a pre-registered test with a selection-honest holdout.

## The holdout, made explicit

- Hypothesis formed on: the 61 cli rows scored in Lane 3. **Spent. Excluded.**
- Judged on: the **249 cli rows never scored**, by id exclusion against
  `results/jev-classify-2026-09-18.json`. Untouched at the time of declaring.
- This is the Stage 5.3 selection-honest holdout, not a re-run.

## Why the cli population is the right label

`cli` rows are the ones where a human ran `hippo remember` and chose, per row,
whether to pass `--error`. The tag is a deliberate human judgment on that row,
not a mechanical property of an import batch. Base rate 129/310 = **0.416**.

Metadata leakage is structurally impossible here: every row shares one source
family, so the source prior that scored 0.774 in Lane 3 is a constant and
carries no information. Only content can separate these rows.

## Sample-size math

- n = 249 expected, ~104 pos / ~145 neg. SE(AUC) = sqrt(0.25/104) = **0.049**.
- Detectable-effect floor **0.098** at 2 SE. Lane 3's cli point estimate was
  0.384 above chance, so the lane is powered for the effect it is testing.
- Cost: 249 x $0.0004 = **$0.10**.

## Decision rule (declared, and attackable)

> PASS only if Jev's AUC on the untouched cli rows beats the best content-only
> baseline by more than 0.098 with a paired bootstrap interval excluding zero,
> AND the hard `kind == 'error'` choice beats the keyword regex on MCC.
> A tie promotes the incumbent: no tag unless a human typed --error.
>
> A PASS here does NOT authorise wiring. It authorises exactly one thing: a
> paired A/B on retrieval quality through LongMemEval, which is the real gate.

**This verdict is only as good as this rule. Attack the rule, not just the numbers.**

## Trial ledger

| N | Lane | Status |
|---|---|---|
| 1 | Jev durable vs useful, raw | RUN, FAIL |
| 2 | Jev durable vs useful, age-normalised | RUN, FAIL |
| 3 | Jev isError vs error tag, all sources | RUN, FAIL (delta +0.098, CI grazes 0) |
| 4 | Jev isError vs error tag, untouched cli holdout | declared 2026-09-18 |

N = 4 verdict lanes. At alpha = 0.05, expected false passes = 0.20.

---

# RESULT — Lanes 3 and 4, run 2026-09-18

656 further live Jev calls, 0 failures, $0.26. Raw output:
`results/jev-classify-lane4-cli-holdout-2026-09-18.json`.

## Lane 3 (all sources, n=400): FAIL

| Scorer | AUC vs `error` tag |
|---|---|
| Jev isError | 0.568 |
| coin flip | 0.492 |
| keyword regex | 0.436 |
| content length | 0.300 |
| source prior (metadata leak, not a bar) | 0.774 |

Delta vs best content-only baseline +0.098, CI [-0.012, 0.148]. The interval
grazes zero, so the lane FAILS its declared rule. The MCC gate passed on its own
(Jev +0.140 vs keyword -0.136) but the rule requires both.

## Lane 4 (untouched cli holdout, n=249): PASS

| Scorer | AUC vs `error` tag |
|---|---|
| **Jev isError** | **0.891** |
| keyword regex | 0.591 |
| coin flip | 0.436 |
| content length | 0.413 |
| source prior | 0.500 (constant by construction, leakage impossible) |

Delta vs the best content-only baseline **+0.300, CI [0.235, 0.369]**. PASS.
Hard choice: Jev MCC **0.483** (acc 0.695, prec 0.599, rec 0.955) vs keyword
MCC 0.180. PASS. **Overall: PASS.**

Replication: the hypothesis set gave 0.884 (n=61), the untouched holdout gave
0.891 (n=249). The estimate did not move.

## Why lane 3 failed and lane 4 passed

Not a contradiction, a population effect. Lane 3 is 59% `shared:` import rows
whose error tag was applied in bulk on 2026-04-08, so the tag there records an
import batch rather than a per-row human judgment. Lane 4 is the population
where a human decided, row by row, whether to type `--error`. Jev predicts the
human judgment well and the bulk import poorly, which is the correct behaviour
for a content-only model.

## Leakage audit (run before accepting the result)

0 of 310 cli rows contain a tag-shaped marker (`[error]`, `tags: error`,
`#error`) in their content. The separation is semantic: error rows read like
"PowerShell treated part of an rg regex as a cmdlet", non-error rows are quant
findings dense in the words fail, REJECT and overfitting. That is exactly why
the keyword baseline sits at 0.591 while Jev sits at 0.891.

## Stage 5.6 self-audit

**Data.** The cli population is now fully spent: 310 rows, 61 in the hypothesis
set and 249 in the holdout. No cli row remains for a third look. Any threshold
tuning needs a new population or new rows accrued after this date.

**Statistics.** The bootstrap resamples rows, not (positive, negative) pairs, so
the interval is slightly optimistic. The delta is +0.300 against a floor of
0.098, so this does not change the verdict. N = 4 verdict lanes at alpha 0.05
gives 0.20 expected false passes; the observed delta is more than 6 SE out.

**Code.** Real defect, self-inflicted: lanes 3 and 4 wrote to the same output
filename and lane 4 overwrote lane 3's per-row data. The lane 4 run itself is
valid because the exclusion list was read before the write, and lane 3's summary
survives above, but lane 3's raw rows are gone. Fixed: the output name now
carries the lane and family. Lane 3 was not re-run; its verdict is FAIL and the
holdout supersedes it for the cli population, so $0.16 of re-run buys nothing.

**Process.** Lane 4 is post-hoc in origin and was converted to a pre-registered
test with a genuine untouched holdout before any call was made. That is the only
reason it counts. Had it been judged on the 61 rows that generated the
hypothesis, it would have been a diagnostic.

## What this authorises, exactly

**Not wiring.** A PASS here authorises exactly one thing, as declared: a paired
A/B on retrieval quality through LongMemEval. Three things block a wire-in:

1. **Over-firing.** Recall 0.955 at precision 0.599. Jev calls 177 of 249 rows
   errors against a base rate of 0.446. As a ranker it is strong, as a hard
   tagger at its default choice it over-tags by roughly 60%. A threshold must be
   picked, and picking one needs its own holdout (Stage 5.5), which the spent
   cli population can no longer provide.
2. **C1 precedent.** Error tags lengthen half-life. Over-tagging makes more
   memories sticky, which is a change to what survives decay, which is a
   retrieval-quality question. ROADMAP C1 (salience gate, recall 81 -> 15) is the
   standing warning that store-shaping changes need the retrieval gate, not a
   classification score.
3. **Latency and cost.** 736ms and $0.0004 per capture. Capture is off the
   latency path; `hippo context` is not. Nothing here licenses Jev in recall.

## Ledger

| N | Lane | Verdict |
|---|---|---|
| 1 | durable vs useful, raw | FAIL |
| 2 | durable vs useful, age-normalised | FAIL |
| 3 | isError vs error tag, all sources | FAIL |
| 4 | isError vs error tag, untouched cli holdout | **PASS** |

Total spend across all four lanes: 1063 live calls, $0.43, 0 failures.

---

# Lane 5 — pre-registered 2026-09-18, BEFORE the first retrieval run

## The decision this gates

Whether auto-applying Jev's error tag improves hippo's retrieval. This is the
real gate named in Lane 4. A PASS here ships the wiring; a FAIL closes it.

## Instrument failure recorded first: LongMemEval cannot test this

LongMemEval was the declared instrument. It is now disqualified, on evidence:
Jev scores 0 of 50 sampled LongMemEval memories above p=0.3 (median 0.05,
max 0.25). The corpus is personal chat (book recommendations, meal planning)
and contains no engineering errors, so both arms would be byte-identical.
Cost of finding out: $0.02.

This generalises. Every public memory benchmark (LoCoMo, LongMemEval, PerLTQA,
MSC, DialSim, MemoryBank, BEAM) is persona chat. None can exercise
error-stickiness, so none can test a hippo-specific physics mechanism. That is
a gap in the benchmark field, not a defect in this experiment.

## Effect ceiling, measured before spending (no API calls)

Using hippo's own `calculateStrength` on the 249 Lane 4 rows:

- 46 of 249 multipliers change under a selective tag; median delta **+0.191**,
  max +0.309.
- Spearman rho between baseline and Jev-arm multipliers **0.895**, so ranking
  genuinely moves. An rho above 0.99 would have closed this without a run.
- Warning: tagging raises rows at the strength clamp from 101 to 197 of 249.
  The Jev arm has LESS strength differentiation and more ties at the top. The
  effect can therefore hurt as easily as help, which is why it is measured.

## Instrument

- Corpus: the live store at `~/.hippo`. Retrieval over all entries.
- Queries: for each of the 249 Lane 4 rows, 6 non-stopword tokens sampled from
  that row's content, shuffled, seeded. This simulates "I half-remember
  something about X Y Z" and forces competition from near-duplicates.
- Ground truth: the row the tokens came from. Exact by construction.
- Arms differ ONLY in the 111 top-p rows: `error` tag added, valence negative,
  half-life doubled. Identical queries, identical corpus, identical seed.
- Metrics: R@1, R@5, R@10, MRR, paired per-query.

## Declared instrument defects

1. **Lexical overlap.** Query tokens are drawn from the target, so BM25 is
   favoured and strength has less room to act. This biases the test toward the
   null: a PASS is therefore trustworthy, a FAIL may be masked. Declared now.
2. **Ceiling check is a gate, not a result.** If baseline R@1 exceeds 0.95 the
   instrument has no headroom and the lane is reported as an INSTRUMENT FAILURE
   with no verdict, exactly as LongMemEval was.
3. **Partial rollout.** Only 249 of ~1900 rows are Jev-scored, so the arms differ
   on 111 rows against a full-store corpus. This is realistic for a staged
   rollout but understates a store-wide effect.

## Decision rule (declared, and attackable)

> SHIP the wiring only if the Jev arm beats baseline on R@5 with a paired
> bootstrap interval excluding zero, AND does not lose on R@1. A tie promotes
> the incumbent: no auto-tagging. A loss on any metric with an interval
> excluding zero closes the idea, matching the C1 precedent.

**This verdict is only as good as this rule. Attack the rule, not just the numbers.**

## Trial ledger

| N | Lane | Status |
|---|---|---|
| 1 | durable vs useful, raw | FAIL |
| 2 | durable vs useful, age-normalised | FAIL |
| 3 | isError vs error tag, all sources | FAIL |
| 4 | isError vs error tag, cli holdout | PASS |
| 5 | retrieval A/B, error tag auto-applied | declared 2026-09-18 |

N = 5 verdict lanes. At alpha = 0.05, expected false passes = 0.25.

---

# RESULT — Lane 5, run 2026-09-18. INSTRUMENT TOO WEAK. No clean verdict.

Raw: `results/jev-retrieval-ab-2026-09-18.json`. 249 paired queries, 0 API cost.

| Metric | Baseline | Jev arm | Delta | 95% CI | Read |
|---|---|---|---|---|---|
| R@1 | 0.9317 | 0.9438 | +0.0120 | [-0.0040, 0.0321] | no difference |
| R@5 | 0.9960 | 0.9960 | +0.0000 | [0.0000, 0.0000] | **no headroom** |
| R@10 | 1.0000 | 1.0000 | +0.0000 | [0.0000, 0.0000] | **no headroom** |
| MRR | 0.9635 | 0.9688 | +0.0053 | [-0.0033, 0.0141] | no difference |

Only **7 of 249** queries changed rank at all.

## Why this is an instrument failure, not a result

Declared defect 1 in the Lane 5 instrument section bit exactly as written: the
query tokens are drawn from the target row, so BM25 pins the target at rank 1
and the strength multiplier never gets to act. Baseline R@5 is 0.9960 and R@10
is 1.0000, so the **primary metric had no room to move in either direction**.

The ceiling gate was declared on R@1 (> 0.95 = instrument failure) and R@1 came
in at 0.9317, just under. That was the wrong metric to gate on: the rule names
R@5 as primary, so the gate should have been on R@5, which is at 0.9960. This
is a defect in my own pre-registration, recorded rather than quietly patched.

## What the lane does and does not establish

- **Does not establish** that auto-tagging fails. The test could not detect an
  effect of any size on the primary metric.
- **Does establish** that the effect is small where the instrument could see it:
  R@1 moved +0.012 with an interval spanning zero, on 7 changed queries.
- **Operationally**, the declared rule stands: a tie promotes the incumbent, so
  no wiring ships today.

## What would settle it

Paraphrased queries, where the query shares no wording with the target and
near-duplicates genuinely compete. `scripts/build-eval-corpus-llm.mjs` already
does this and needs `ANTHROPIC_API_KEY`, which is not set on this box. Until
those queries exist, Lane 5 cannot be judged. Cost estimate for the full
version: ~300 generated queries plus scoring the remaining ~1650 unscored rows
with Jev at $0.0004 each, roughly $1 to $3 total.

## Ledger

| N | Lane | Verdict |
|---|---|---|
| 1 | durable vs useful, raw | FAIL |
| 2 | durable vs useful, age-normalised | FAIL |
| 3 | isError vs error tag, all sources | FAIL |
| 4 | isError vs error tag, cli holdout | **PASS** |
| 5 | retrieval A/B, error tag auto-applied | INSTRUMENT TOO WEAK, no verdict |

Campaign spend to date: 1113 live Jev calls, $0.45, 0 failures.

---

# RESULT — Lane 3R, full-population re-run, 2026-09-18. FAIL store-wide.

Raw: `results/jev-classify-lane3-all-2026-09-18.json`. Every eligible row in the
live store scored, not a sample: 1917 of 1917, seed 611, $0.7668, 0 failures,
65.2s wall.

| Scorer | AUC vs `error` tag |
|---|---|
| Jev isError | 0.554 |
| coin flip | 0.495 |
| keyword regex | 0.428 |
| content length | 0.295 |
| source prior (LEAK, not a fair bar) | 0.764 |

Primary: delta vs best content-only baseline (coin flip) **+0.064**, CI
[0.018, 0.091]. The CI excludes zero but the point estimate sits under the
declared 0.075 noise floor, so the rule says **FAIL**. MCC gate passes
(Jev 0.100 vs keyword -0.150). **OVERALL: DO NOT SHIP** store-wide.

## The within-source split is the whole story

| Family | n | tagged `error` | base rate | Jev AUC |
|---|---|---|---|---|
| shared | 1127 | 840 | 0.745 | 0.602 |
| cli | 310 | 129 | 0.416 | **0.883** |
| capture | 157 | 35 | 0.223 | 0.728 |

`shared` is 59% of the store and drags the pooled number to 0.554. It is the
2026-04 bulk import whose error tag was applied in batch rather than per row,
so its label is not a judgement Jev could recover even in principle.

**This is NOT an independent replication of Lane 4.** The full-store run scored
every row, so its 310 cli rows are a SUPERSET of Lane 4's 249 holdout rows:
roughly 80% shared data. What it establishes is that the Lane 4 estimate is
stable when the remaining ~61 cli rows are added (0.891 -> 0.883), not that a
fresh sample reproduces it. `capture` at 0.728 on n=157 IS new: that family was
never scored as its own lane before.

## Kind distribution across the whole store

`{error: 961, decision: 426, convention: 351, trivia: 143, preference: 36}`

---

# PRE-REGISTRATION — Lane 6: retrieval A/B on paraphrased queries

Declared 2026-09-18, BEFORE the run. Supersedes Lane 5, which could not be
judged because its queries were token samples from the target row.

## The question

Does auto-applying the `error` tag to the rows Jev ranks highest improve
retrieval on queries that do NOT share wording with the target?

## Instrument

- **Corpus**: the full live store, every entry, both arms identical in content.
- **Queries**: paraphrases written by 4 Sonnet sub-agents over 320 memories
  sampled at seed 777 from the 1215 rows with `kind != 'archived'` and
  `length(content) > 80`. The brief forbids reusing distinctive wording,
  identifiers, error strings, paths, or any 3-word span from the source, and
  instructs the agent to SKIP a memory too vague to query honestly. Expected
  yield 250-320.
- **Jev scores**: all 1917 rows, from the Lane 3R full-store run above. No
  further API spend; Lane 6 costs $0.
- **Jev arm mutation**: top-K rows by `p(isError)` get `tags += 'error'`,
  `emotional_valence = 'negative'`, `half_life_days x 2`, which is exactly what
  `deriveHalfLife` does at `src/memory.ts:394-396`. K = the store's own error
  base rate x n, declared in advance, never tuned.

### Defect found in the Lane 5 mutation, fixed here before the Lane 6 run

`src/memory.ts:523` derives `half_life_days` at creation through
`deriveHalfLife`, which already doubles it for an error-tagged row. The stored
value therefore ALREADY carries the 2x. The Lane 5 mutation applied
`half_life_days * 2` unconditionally to every row in the top-K, so any row that
was already tagged got **4x**, plus a duplicate `'error'` string in its tag
array. Lane 6 inherited that code verbatim until the dry run made the tag
counts visible.

Fixed: only rows Jev ADDS the tag to are mutated. Rows already carrying the tag
are left in their real state, because that state is already the thing the tag
produces. At K = 1066 on this store the split is **616 rows where Jev agrees
with the existing tag** and **450 rows Jev newly tags**, which is the actual
size of the intervention (23% of the store), not 1066.

This is an ADDITIVE design, matching how hippo would really deploy it: Jev
would score new memories on write, never retroactively untag old ones. The
replacement design ("Jev's top-K is the complete error set, remove the rest")
is a different experiment and is NOT run here.

**What this means for Lane 5**: its arm was over-boosted at 4x and still moved
only 7 of 249 ranks. The bug makes that lane's "no detectable effect" finding
stronger, not weaker, so its INSTRUMENT TOO WEAK verdict stands unchanged and
is not re-run.

## Sample-size math FIRST

A paired proportion delta is carried by the DISCORDANT pairs only. At n = 300
queries and a discordant rate of ~15% (about 45 pairs), the detectable delta on
R@5 is roughly `2 x sqrt(45) / 300 = 0.045`. **The floor is +-4.5pp.** Any
delta smaller than that is inside the noise and gets reported as a tie, not as
a small win. Lane 5 produced 7 discordant pairs out of 249; anything in that
range means the instrument failed again.

## Ceiling gate, on the PRIMARY metric this time

Lane 5's gate was declared on R@1 while the decision rule named R@5 as primary,
so it did not fire when R@5 came in at 0.9960 with zero headroom. Fixed here:

> **If baseline R@5 > 0.95, the lane is an INSTRUMENT FAILURE and returns no
> verdict, regardless of what the deltas look like.**

## Decision rule, declared

- **Primary**: R@5. Paired bootstrap, 2000 draws, 95% CI on the delta.
- **Secondary, reported always**: R@1, R@10, MRR.
- **PASS requires**: R@5 CI excludes 0 upward AND the R@1 CI upper bound is not
  below 0 (no silent top-slot regression bought with mid-list gains).
- A tie promotes the incumbent. No wiring ships on a tie.

## Declared confounds

1. **The paraphrase agent saw the memory.** It may pick a term that is
   semantically exact in a way a real user would not reach for. Mitigation: a
   mechanical overlap audit runs BEFORE the verdict (below), not after.
2. **LLM queries are not user queries.** This measures paraphrase robustness,
   which is the closest available proxy, not live user behaviour. Stated as a
   limit on the verdict, not fixed.
3. **Sampling is store-wide, not Jev-tagged-only.** Deliberate: a tag that
   lifts tagged rows by pushing untagged rows down is not an improvement. The
   net effect across a random sample is the thing being measured.
4. **`shared` rows dominate the store.** Any pooled retrieval number inherits
   that mix. Per-family breakdown rides the result.

## Leakage audit, run before the verdict is read

**Amended 2026-09-18, before the run, no data seen.** The first draft of this
section declared token-level Jaccard with a 0.30 flag. That is the wrong
statistic: a query is ~8 tokens and a target is up to ~1000, so the union term
dominates and Jaccard is near zero for every pair including a verbatim copy. It
would have flagged nothing and passed a broken audit. Replaced with two
measures, declared here before any Lane 6 number exists:

1. **Containment** = fraction of the query's content tokens (stopwords removed)
   that appear in the target. Reported as a distribution. High containment
   alone is not leakage: ordinary domain words are how anyone would describe
   the topic.
2. **Rare-token hits** = count of query tokens that appear in the target AND in
   fewer than 1% of corpus documents. This is the leak that matters: a copied
   identifier, flag, error string, or path. **A pair with 2 or more rare hits
   is flagged.**

### Threshold calibration, 2026-09-18, on batch 1 only, no retrieval rank seen

The 1%-of-documents rule above was set by arithmetic, not by looking at data.
Run against the first 77 queries it flags 13, and the flagged tokens are
`["debug","symbols","warning"]` and `["bot","group","chat"]`: ordinary domain
vocabulary that is rare only because the corpus is 1942 documents, not copied
identifiers. The flag was measuring corpus size, not leakage.

Flag rate by document-frequency threshold, 2+ hits, on the same 77 rows:

| token appears in <= N docs | 1 | 2 | 3 | 5 | 10 | 19 (the 1% rule) |
|---|---|---|---|---|---|---|
| pairs flagged | 0 | 0 | 0 | 2 | 5 | 13 |

**Zero pairs carry two tokens from the target that appear in 3 or fewer
documents.** No identifier was copied. The 1% rule was flagging vocabulary.

Adopted, replacing the rule above:

> **Flag = a verbatim 3-word span shared with the target that contains at
> least 2 non-stopword tokens AND at least one token appearing in 1% or
> fewer of corpus documents, OR 2 or more shared tokens appearing in 3 or
> fewer corpus documents.**

The distinctiveness clause is load-bearing. Without it the span rule passes
`"the api key"`, whose "api" and "key" are both content words but are the
subject matter of the corpus, not copied wording. With it, `"debug symbols
warning"` still flags because "symbols" is rare.

On batch 1 this flags **1 of 77**: `"why cant i clear the missing debug symbols
warning in play console"`, which reuses the span `"debug symbols warning"` from
its target. That is a genuine brief violation and it is also the real name of
the warning, which is what a user would type. It stays flagged.

**Three iterations on one definition, recorded rather than hidden**: Jaccard
(wrong denominator), then 1%-rare tokens (measured corpus size), then a
content-bearing span (passed generic phrases), then span AND distinctiveness.
The common defect in the first three was trying to express leakage as one
statistic. It needs two: a span that is shared AND a word that is rare. Locked
here; no further tuning without a dated entry and a stated reason.

This is an instrument-calibration change made with query text visible and
**zero outcome data seen**: not one retrieval rank had been computed when it
was made. Recorded here rather than applied quietly. The direction of the
change reduces the number of rows dropped from the sensitivity arm, which
preserves power; the conservative direction would have been to keep
over-flagging, and the reason for not doing so is that the over-flagged rows
are not leaks.

The primary metric is re-computed with flagged pairs excluded, as a declared
sensitivity analysis. **If the two numbers disagree, the excluded-pairs number
is the verdict.**

## NOT DONE in this lane, and why

| Declared but not run | Why |
|---|---|
| Live user queries | None logged; `recall_traces` is starved by the `!pinnedOnly` guard at `src/api.ts:2777`. |
| Human-written paraphrases | No annotator budget. LLM paraphrase is the stated proxy. |
| Per-family A/B powered separately | n per family after paraphrase yield is under the 300-anchor thin-window floor; goes to the accrual list. |
| Re-scoring `shared` labels by hand | 1127 rows; the batch-tagged label is the confound, and fixing it is a different project. |

## Trial ledger

| N | Lane | Verdict |
|---|---|---|
| 1 | durable vs useful, raw | FAIL |
| 2 | durable vs useful, age-normalised | FAIL |
| 3 | isError vs error tag, all sources | FAIL |
| 4 | isError vs error tag, cli holdout | PASS |
| 5 | retrieval A/B, token-sampled queries | INSTRUMENT TOO WEAK |
| 3R | isError vs error tag, full population | FAIL store-wide |
| 6 | retrieval A/B, paraphrased queries | declared 2026-09-18 |

N = 7 verdict lanes. At alpha = 0.05, expected false passes = 0.35. Lanes 3, 4
and 3R share data and are not independent draws; the Bonferroni-shaped bound
over-punishes them, which is stated rather than corrected for.

---

# RESULT — Lane 6, run 2026-09-18. DO NOT SHIP. The instrument finally worked.

Raw: `results/jev-retrieval-ab-paraphrase-2026-09-18.json`. 303 paraphrase
queries from 4 independent Sonnet agents, $0 API cost.

Baseline R@5 is **0.4026**, not 0.9960. The ceiling gate did not trip, and
**191 of 303** pairs changed rank against 7 of 249 in Lane 5. The test could
see effects this time.

| Metric | Baseline | Jev arm | Delta | 95% CI | Read |
|---|---|---|---|---|---|
| R@1 | 0.2112 | 0.2211 | +0.0099 | [-0.0132, 0.0330] | no difference |
| **R@5 (primary)** | 0.4026 | 0.4191 | +0.0165 | [-0.0066, 0.0429] | **no difference** |
| R@10 | 0.4686 | 0.5050 | **+0.0363** | **[0.0165, 0.0594]** | **JEV WINS** |
| MRR | 0.3093 | 0.3183 | +0.0090 | [-0.0040, 0.0235] | no difference |

Sensitivity arm, 6 leak-flagged pairs excluded, n=297: same direction, same
magnitudes, same verdict. Primary and sensitivity agree, so the tie-break rule
is not invoked.

**VERDICT by the declared rule: DO NOT SHIP.** R@5 was named primary before the
run, its interval spans zero, and a tie promotes the incumbent.

## What the numbers actually say

The R@5 null is not an underpowered miss. The bootstrap interval is about
+-2.5pp wide, BETTER resolution than the +-4.5pp floor declared at
pre-registration, because discordant pairs came in at 63% rather than the 15%
assumed. The effect at depth 5 is genuinely small.

All four deltas are positive and the one at depth 10 survives its interval.
Read together: Jev's tagging lifts memories from around rank 11-20 into the top
10, and does not lift them into the top 5. One metric of four cleared its
interval, in lane 7 of 7, so the ledger's 0.35 expected false passes applies
directly to it.

## Leakage audit, as declared

Containment p25 0.143, median 0.286, p75 0.429. Six of 303 pairs flagged, all
by shared 3-word span, none by 2+ ultra-rare tokens except one. The paraphrase
brief held across all four agents.

## Stage 0 DEFECT, found after the run: the primary metric was the wrong depth

`src/search.ts:410` cuts retrieval by **token budget, default 4000**, not by
rank. Measured on 60 queries against the live store at that default:

| | min | p25 | median | p75 | max |
|---|---|---|---|---|---|
| memories returned | 18 | 25 | **28** | 32 | 41 |

**hippo returns a median of 28 memories.** Neither R@5 nor R@10 is the depth
the system operates at. Stage 0 of the protocol says instrument mechanics are
"measured, not assumed"; R@5 was picked by IR convention without checking what
hippo does, and that is a violation of the campaign's own opening rule.

The Lane 6 verdict is NOT revised. The rule was declared before the run and it
returns DO NOT SHIP; changing the metric after seeing the result is the exact
move the pre-registration exists to prevent.

---

# PRE-REGISTRATION — Lane 7: retrieval A/B at the operational cut

Declared 2026-09-18, BEFORE the run, after the Lane 6 verdict was recorded.

## Why this lane exists, and the selection risk in it

Lane 6 measured recall at ranks 5 and 10. hippo cuts at a 4000-token budget
admitting a median of 28 memories. The operationally meaningful question was
never asked: **does a memory make it into the context the agent actually
receives?**

**Stated plainly: this metric is being chosen AFTER seeing R@10 win.** That is
a selection risk and it is declared rather than hidden. Two things bound it:

1. The metric is fixed by the system's own behaviour, measured above, not by
   which number came out largest. Any reader can re-derive 28 from
   `search.ts:410` and the store.
2. **The change plausibly makes the test HARDER, not easier.** Deeper cuts mean
   higher recall in both arms and less headroom. Baseline R@10 is already
   0.4686; recall within budget will be higher, leaving less room to win.

If Lane 7 passes, it passes with those caveats attached and the ledger at N=8.

## Instrument

Identical corpus, identical query set, identical Jev arm mutation as Lane 6.
The only change: `hybridSearch` is called with hippo's DEFAULT options, so the
4000-token budget decides the cut, exactly as in production.

## Decision rule, declared

- **Primary**: recall within the default token budget. Binary per query: is the
  target in the returned set. Paired bootstrap, 2000 draws, 95% CI.
- **Secondary, reported always**: R@1, R@5, R@10, R@28, MRR.
- **PASS requires**: the primary CI excludes 0 upward AND the R@1 CI upper
  bound is not below 0.
- **Ceiling gate**: baseline primary > 0.95 means instrument failure and no
  verdict, same as Lane 6.
- A tie promotes the incumbent.

## Trial ledger

| N | Lane | Verdict |
|---|---|---|
| 1 | durable vs useful, raw | FAIL |
| 2 | durable vs useful, age-normalised | FAIL |
| 3 | isError vs error tag, all sources | FAIL |
| 4 | isError vs error tag, cli holdout | PASS |
| 5 | retrieval A/B, token-sampled queries | INSTRUMENT TOO WEAK |
| 3R | isError vs error tag, full population | FAIL store-wide |
| 6 | retrieval A/B, paraphrased, R@5 primary | FAIL (R@10 won, not primary) |
| 7 | retrieval A/B, paraphrased, budget-cut primary | declared 2026-09-18 |

N = 8 verdict lanes. At alpha = 0.05, expected false passes = 0.40. Lanes 6 and
7 share their entire query set and corpus and differ only in the cut, so they
are near-duplicate draws, not independent ones.

---

# RESULT — Lane 7, run 2026-09-18. DO NOT SHIP. This closes the retrieval question.

Raw: `results/jev-retrieval-ab-opcut-2026-09-18.json`. Same 303 queries, same
corpus, same Jev arm. Only the cut changed, to hippo's production default.
Console labelling in this run still read "Lane 6"; the JSON recorded
`protocol: Lane 7` and `primary_metric: recall@budget` correctly and is
authoritative. Label fixed afterwards.

| Metric | Baseline | Jev arm | Delta | 95% CI | Read |
|---|---|---|---|---|---|
| R@1 | 0.2112 | 0.2211 | +0.0099 | [-0.0132, 0.0330] | no difference |
| R@5 | 0.4026 | 0.4191 | +0.0165 | [-0.0066, 0.0429] | no difference |
| R@10 | 0.4686 | 0.5050 | +0.0363 | [0.0165, 0.0594] | JEV WINS |
| R@28 | 0.5875 | 0.5974 | +0.0099 | [-0.0066, 0.0264] | no difference |
| **recall@budget (primary)** | 0.6106 | 0.6007 | **-0.0099** | [-0.0330, 0.0132] | **no difference** |

Sensitivity arm, n=297: identical picture, primary -0.0101 [-0.0337, 0.0135].

**VERDICT: DO NOT SHIP.** The primary interval spans zero and its point
estimate is negative.

## The mechanism, which the two lanes together make legible

R@10 rises by 3.6pp while recall within the budget FALLS by 1.0pp. That is
reordering, not admission. The strength multiplier lifts some memories up the
ranking, but the cut is by TOKEN COUNT: promoting a long memory into the top 10
displaces others, and the set the agent actually receives does not grow.

Discordant pairs fall from 191 (Lane 6) to 86 (Lane 7), because most of Lane
6's rank movement happened outside the returned set entirely and was invisible
to the user either way.

**The selection risk declared in the Lane 7 pre-registration did not pay off,
which is the cleanest possible outcome for it.** The metric was chosen after
seeing R@10 win, and it returned a negative point estimate. A post-hoc metric
that fails is evidence the post-hoc choice was not a rescue attempt.

## Per-source, diagnostic only, all under the 300-anchor thin-window floor

| Source | n | recall@budget base -> Jev | Delta |
|---|---|---|---|
| shared | 150 | 0.6733 -> 0.6667 | -0.0067 |
| cli | 78 | 0.5769 -> 0.5385 | -0.0385 |
| claude-memory | 44 | 0.5000 -> 0.5227 | +0.0227 |
| capture | 12 | 0.5000 -> 0.5000 | 0.0000 |
| consolidation | 12 | 0.5833 -> 0.5833 | 0.0000 |

`cli` is the family where Jev classifies best (AUC 0.883) and it is the family
that loses most here. Classification skill does not transfer to retrieval gain.

---

# STAGE 5.6 SELF-AUDIT — what else is wrong with what I did

Mandated before a campaign verdict. Coverage across all four categories.

## Data

1. **The `error` label is not one thing.** 59% of the store is a 2026-04 bulk
   import tagged in batch. Lanes 3 and 3R pool it with per-row human judgement
   and the pooled AUC (0.554) is a mixture statistic that describes no real
   population. Only the within-source numbers mean anything.
2. **The paraphrase sample is not the store.** It is drawn from rows with
   `length(content) > 80` and `kind != 'archived'`, and 15 of 320 were skipped
   by the agents as too vague. Short and vague memories are systematically
   absent, and those are plausibly the ones retrieval handles worst.
3. **Queries are LLM-written, not user-written.** Declared as a confound up
   front and still true. The generating agents saw the target, which no real
   user does. The leakage audit bounds copied WORDING; it cannot bound copied
   CONCEPTS.

## Statistics

4. **One metric of four cleared its interval in Lane 6 and it was not the
   primary.** With the ledger at N=8, expected false passes is 0.40. The R@10
   result is exactly the size of thing that ledger predicts will appear by
   chance across a campaign this wide.
5. **Lanes 6 and 7 are not independent.** Same queries, same corpus, same arm,
   differing only in the cut. Counting them as 2 of 8 overstates the evidence;
   they are closer to one lane reported two ways.
6. **The R@10 win was never bootstrapped against a process null.** Stage 5.2
   asks for the whole recipe re-run on information-free inputs. It was not
   done here, so I cannot say what R@10 delta this pipeline manufactures from
   noise. NOT-DONE, not passed.
7. **K was fixed at the store base rate, never swept.** A different K might
   help or hurt. Declaring it in advance was the right call for honesty and it
   means the lane tests one point on a curve, not the curve.

## Code

8. **The Lane 5 4x half-life bug shipped into Lane 6 and survived to the dry
   run.** It was caught by printing tag counts, not by a test. There is still
   no test on the arm-construction logic, which is the single most
   verdict-critical code in the campaign.
9. **Three iterations on the leakage flag**, two of them wrong in ways that
   would have passed silently: Jaccard would have flagged nothing, the 1% rule
   flagged vocabulary. Both were caught by looking at what got flagged. A flag
   whose output is never eyeballed is not a check.
10. **The Lane 3 / Lane 4 filename collision** destroyed Lane 3's per-row data
    earlier in this campaign. Fixed by tagging output paths, but the lost rows
    were never regenerated.

## Process

11. **The Stage 0 rule was violated by the campaign that declared it.** "Instrument
    mechanics measured, not assumed" is the second item in Stage 0, and R@5 was
    chosen by IR convention without ever checking that hippo cuts by token
    budget. Two full lanes ran at the wrong depth before anyone measured 28.
12. **No independent process critique (Stage 5.7) has been run.** Every lane in
    this campaign was designed, run, and judged by the same hands. That is the
    single largest uncontrolled risk in the whole thing.
13. **The campaign grew lane by lane rather than being designed once.** Lane 6
    was pre-registered only after Lane 5 failed; Lane 7 only after Lane 6. Each
    declaration was honest and pre-run, but the SHAPE of the campaign was
    chosen with full knowledge of prior results.

Stage 5.7 (independent process critique) launched 2026-09-18 against finding
12, reviewer given artifacts not summaries. It landed. See the section below.
It found eight things this audit missed, and the pattern connecting them is
that this audit interrogated the statistics and the process and never once
asked WHICH ROWS the intervention landed on.

---

# STAGE 5.7 — INDEPENDENT PROCESS CRITIQUE, 2026-09-18

Reviewer had the artifacts, not the summaries. Findings 1-12 in its report;
the four that change something are recorded here with my own re-derivation
beside them. I re-ran the load-bearing one from scratch rather than take it
on trust: `scratchpad/verify-length-confound.mjs`, no reuse of its scripts.

## C1. Jev's isError score is substantially a LENGTH detector, running backwards

Independently confirmed. Token counts, whitespace split, live store:

| population | n | mean | median |
|---|---|---|---|
| real `error`-tagged rows | 1067 | 34.9 | **12** |
| real non-error rows | 865 | 86.1 | **54** |
| Jev's top-K (its "error" set) | 1058 | 77.7 | **54** |
| Jev's below-K | 847 | 34.7 | **11** |

Jev's error set has the length profile of the real NON-error set, and its
non-error set has the profile of the real error set. Spearman(Jev p, content
length) = **+0.4885**. Real error memories here are short ("X breaks, do Y");
Jev reads long careful prose as error-like.

This is the undiagnosed cause of the Lane 3R store-wide FAIL. The campaign
reported AUC 0.554 and never asked what Jev was keying on.

It is also why the retrieval arm loses. The 453 newly tagged rows have median
**98** tokens against **16** for everything else. Promoting the long tail into
a 4000-token cut evicts multiple short rows per long row admitted, before any
retrieval physics is consulted.

## C2. The published mechanism was WRONG

The Lane 7 result above says "reordering, not admission... the set the agent
actually receives does not grow". The reviewer stratified by whether the
target was one of the treated rows and found admission moves hard in BOTH
directions: treated targets +3.1pp INTO the budget, untreated targets -2.9pp
OUT of it. The near-zero pooled number is two opposing admission effects
cancelling, not the absence of one. **The single most quotable sentence in
this document is contradicted by its own raw file.** Left standing above, with
this correction attached, because deleting a wrong call is worse than marking it.

## C3. The pooled null hides a win and a loss

Stratified, 5000-draw paired bootstrap:

| metric | stratum | n | delta | 95% CI |
|---|---|---|---|---|
| R@5 | treated target | 98 | **+0.0816** | [0.0204, 0.1531] |
| R@10 | treated target | 98 | **+0.1122** | [0.0510, 0.1837] |
| recall@budget | untreated target | 205 | **-0.0293** | [-0.0537, -0.0098] |

Lane 5's own rule: "A loss on any metric with an interval excluding zero
closes the idea." The untreated majority takes exactly that loss. The verdict
should read **measured harm**, not tie-goes-to-the-incumbent. Caveat kept: the
reviewer's split is post-hoc across 18 intervals and -0.0293 at ~2.3 SE would
not survive Bonferroni at 18. It is one mechanically forced split, not a
search, and it needs a declared lane before it counts.

## C4. 35% of the intervention lands on a family with zero error tags

Confirmed independently, by source family:

| family | rows | real error tags | newly tagged by Jev | median tokens |
|---|---|---|---|---|
| shared | 1130 | 838 | 117 | 11 |
| cli | 308 | 129 | 100 | 71 |
| **claude-memory** | **208** | **0** | **157** | **202** |
| capture | 172 | 37 | 45 | 10 |
| consolidation | 73 | 49 | 12 | 21 |
| cli-global | 41 | 14 | 14 | 88 |

`claude-memory` has no error tags at all, is the longest family by a factor of
two, and absorbs 157 of the 453 tags. Every one is a false positive under this
campaign's own ground truth, and they are the rows that evict the most.
Lane 3R's within-source table omitted this family entirely.

## What survived the attack

- The paired bootstrap is correctly implemented; the query is the resampling
  unit and pairing is preserved. 303 queries, 303 distinct targets, no clustering.
- `recall@budget` is computed as the prose claims.
- The Lane 5 4x half-life fix is correct, and the valence overwrite is faithful.
- **Lane 4 is not a length artifact, and it is the strongest result here.**
  Within `cli`, AUC(length -> error tag) = **0.413**, anti-predictive, while
  Jev scores **0.883**. On the one population where source metadata is constant
  and length points the WRONG way, Jev still reads the label. Re-derived
  independently this turn.

## Its verdict

DO NOT SHIP survives, and should be strengthened from "tie" to "measured harm
to untreated memories". But the campaign's stated REASON was wrong, and the
scope claim "this closes the retrieval question" is not earned: Lanes 6 and 7
tested a near-chance, length-biased tagger applied store-wide at no threshold,
having already failed it in Lane 3R.

## The lane this opens, and it is not about Jev

If a strength boost on a long memory evicts several short ones from a
token-bounded window, that is true of the user's OWN hand-set `error` tags. It
is a property of hippo's physics meeting hippo's budget cut, with no external
API involved. That is a product question, it is free to test, and no lane in
this campaign asked it.

---

# CAMPAIGN VERDICT — 2026-09-18

## Closing ledger

| N | Lane | What it asked | Verdict |
|---|---|---|---|
| 1 | durable vs useful, raw | can Jev predict which memories got used | FAIL |
| 2 | durable vs useful, age-normalised | same, age controlled | FAIL |
| 3 | isError vs error tag, all sources | can Jev spot an error memory | FAIL (pooled) |
| 3R | isError vs error tag, full population | same, all 1917 rows | FAIL store-wide, AUC 0.554 |
| 4 | isError vs error tag, cli holdout | same, hand-written memories only | **PASS**, AUC 0.891 |
| 5 | retrieval A/B, token-sampled queries | does the tag help retrieval | NO VERDICT, instrument too weak |
| 6 | retrieval A/B, paraphrased, R@5 primary | same, working instrument | FAIL (R@10 won, not primary) |
| 7 | retrieval A/B, paraphrased, budget cut | same, at the real cut | **DO NOT SHIP** |

N = 8. Expected false passes at alpha 0.05 = 0.40. One PASS observed. Lanes 6
and 7 are near-duplicate draws.

## The answer

**Classification: yes, on hand-written memories only.** AUC 0.891 on the
untouched `cli` holdout, 0.883 on the full `cli` population. The bar it clears
is not a low one: the keyword-regex baseline is NEGATIVELY correlated with the
label (MCC -0.150), so string matching is worse than a coin flip here and Jev
is not. On the bulk-imported 59% of the store it is near chance (0.554
pooled), and that is the population, not the exception.

**Retrieval: no.** Two lanes, one working instrument, 303 paraphrased queries
sharing no wording with their targets. At the rank cut the primary missed and
only R@10 moved; at the real token-budget cut the primary point estimate is
NEGATIVE and its interval spans zero. The mechanism is understood, not
mysterious: the tag reorders the list without admitting more memories through
a token-based cut.

## What this licenses

Shipping nothing automatic. The `error` tag stays user-set. `src/judgment.ts`
stays dormant with no call site, or is deleted.

A Stage 6 promotion gate would be needed to ship the classification result,
and has NOT been run. No promotion is being proposed, so no gate is being
skipped; a decline needs no gate.

---

# Lane 8 — pre-registered 2026-09-18, BEFORE the first run

No external API. This tests HIPPO, not Jev. It exists because Stage 5.7 found
that the retrieval loss tracked document LENGTH, and hippo's own error-
stickiness applies the same boost to the user's own hand-set `error` tags.

## The question

Error-stickiness is a shipped feature: an `error` tag doubles a memory's
half-life, which raises its strength, which multiplies its composite score.
The retrieval cut is by TOKEN BUDGET. So promoting a long error memory evicts
several short ones. **Does the feature earn its place, or is it quietly
costing recall on every query?**

## The chain, read in source this turn, not recalled

- `src/memory.ts:394-396` — `deriveHalfLife` doubles `hl` when tags include `error`
- `src/memory.ts:523` — applied at WRITE time, stored in `half_life_days`
- `src/memory.ts:332` — `effectiveHalfLife = entry.half_life_days * rewardFactor`
- `src/search.ts:572-574` — `strengthMultiplier = 0.5 + 0.5 * strength`, bounded [0.5, 1.0]
- `src/search.ts:585` — `compositeScore = base * strengthMultiplier * recencyMultiplier`
- `src/search.ts:410` — `const budget = options.budget ?? 4000`

Maximum possible boost from strength is therefore 2x on the composite score.

## Measured population state

| | rows | median half-life | median tokens |
|---|---|---|---|
| `error`-tagged | 1064 | 22 | 12 |
| everything else | 866 | 9.5 | 53 |

The doubling is live and visible. 11 pinned rows return strength 1.0 and are
immune; they are left in both arms.

## Arms

Corpus is built once and shared. **Tags are NOT mutated**, which closes the
BM25 spillover Stage 5.7 found in the Lane 6/7 runner (adding the token
`error` shifted `idf('error')` and `avgLen` for every document, including
controls). Only `half_life_days` moves.

- **ON** (incumbent, = what ships today): the store as it is.
- **OFF**: `half_life_days / 2` on every row whose tags include `error`. Nothing else.
- **PLACEBO** (Stage 5.2 process null, 20 replays): error rows set to OFF, then
  `x2` applied to a random set of the same size drawn to MATCH the error rows'
  token-length distribution (deciles). Answers whether the effect is about
  errorness or merely about promoting long documents.

`now` is pinned to one timestamp for the whole run so decay cannot drift
between arms.

## Queries, and their declared limitation

The same 303 paraphrased queries from Lane 6. 127 targets are error-tagged,
173 are not, 3 ids no longer resolve.

**Stated up front:** the query sample required `length(content) > 80`, so
stratum E targets have median 55 tokens against 12 for the error population.
The targets are the LONG TAIL of each family. This under-samples exactly the
short error memories the feature is best for, and it biases this lane
CONSERVATIVE on the benefit side. Declared, not discovered later.

## Metrics and strata, declared before the run

**Primary, one number:** pooled `recall@budget` at the default 4000-token cut,
ON minus OFF. Positive = the feature earns its place.

**Two confirmatory secondaries**, Bonferroni alpha 0.025 each:
- **Stratum E** (n=127, target is error-tagged): expect ON > OFF.
- **Stratum N** (n=173, target is not): expect ON < OFF from eviction.

Everything else (R@1, R@5, R@10, R@28, per-source) is diagnostic and cannot
move the verdict. Interval count will be reported, per Stage 5.7 finding 11.

**Returned-set size is recorded per arm per query.** Stage 5.7 finding 8: the
Lane 6/7 runner threw `res.length` away, so its recall loss could not be split
into "ranked worse" and "returned fewer". One field closes that.

## The deliverable: the exchange rate

If ON gains +x on stratum E and loses -y on stratum N, the feature is worth
keeping only if one error memory is worth more than y/x ordinary memories.
Report that ratio with its interval. Uniform-weight recall assumes the ratio
is 1. That assumption is the thing actually under test, and naming it is the
point of the lane.

## Decision rule, declared before the run

- **KEEP**: pooled delta >= 0 and its CI does not exclude 0 downward.
- **FIX**: stratum N loss CI excludes 0 downward AND the loss concentrates in
  long promoted memories. The fix is then a product change, e.g. charging the
  strength boost against token cost or capping it by length.
- **KILL**: pooled delta CI excludes 0 downward.
- A tie everywhere KEEPS the incumbent. The feature ships today; parsimony
  favours no change.
- The PLACEBO reproducing the stratum N loss reads the whole effect as length,
  not errorness, and sends it to FIX regardless of the pooled number.

## Trial ledger

| N | Lane | Verdict |
|---|---|---|
| 1 | durable vs useful, raw | FAIL |
| 2 | durable vs useful, age-normalised | FAIL |
| 3 | isError vs error tag, all sources | FAIL |
| 3R | isError vs error tag, full population | FAIL store-wide |
| 4 | isError vs error tag, cli holdout | PASS |
| 5 | retrieval A/B, token-sampled queries | INSTRUMENT TOO WEAK |
| 6 | retrieval A/B, paraphrased, R@5 primary | FAIL |
| 7 | retrieval A/B, paraphrased, budget cut | DO NOT SHIP |
| 8 | hippo error-stickiness, physics ON vs OFF | RUN, KEEP (pooled tie, E stratum gain) |

N = 9. Expected false passes at alpha 0.05 = 0.45. Lane 8 shares its query set
with 6 and 7 but tests a DIFFERENT intervention on a DIFFERENT population
(1064 real tags, not 453 Jev tags), so it is a new draw, not a re-read.

## What this lane cannot do

It cannot tell you whether error memories deserve extra weight. It measures
the COST of the current weighting and the benefit under an equal-weight
assumption. Setting the true weight is a product judgement, not a measurement.

## AMENDMENT 1, 2026-09-18, before the first run

Two things found while building the runner. Both are recorded BEFORE any rank
is computed, and neither is an outcome.

**1. My stated expectation for stratum N is probably wrong, and I am leaving
it in rather than quietly fixing it.**

The eviction story came from the Jev arm, which tagged rows of median **98**
tokens. Hippo's REAL error tags sit on rows of median **12** tokens, against
53 for everything else. Error memories here are short: "X breaks, do Y."

Promoting short documents into a token-bounded window ADMITS MORE, it does not
evict. So the mechanism that sank the Jev arm may run the opposite way for
hippo's own physics, and this lane may find ON > OFF on both strata. That
would be a real result: error-stickiness is cheap precisely because the
memories it favours are small.

The prediction stays on the record as written. A pre-registration that gets
edited once its author sees further is not one.

**2. The placebo cannot be size-matched, and I am not pretending otherwise.**

1064 error rows against 866 non-error rows: there is no same-size control
group, and matching to the error rows' SHORT length profile is supply-limited
at exactly the end that matters. The placebo is therefore run as greedy
nearest-length matching from the non-error pool, taking every pair inside a
25% relative-length tolerance.

The achieved n and the median absolute length gap are reported beside its
result. **If the median gap exceeds 25% of the median error-row length, the
placebo is declared too weak to control anything and is reported as a
diagnostic with no verdict weight.** That threshold is set now, not after.

---

# RESULT — Lane 8, run 2026-09-18. KEEP. Amendment 1 called it.

Raw: `results/hippo-error-stickiness-2026-09-18.json`. Runner:
`scripts/hippo-error-stickiness-ab.mjs`. No API, no cost. The ON/OFF arms are
deterministic and reproduced identically across three runs.

## Primary: pooled, n=300

| metric | ON (ships) | OFF | delta | 95% CI | read |
|---|---|---|---|---|---|
| R@1 | 0.2133 | 0.2000 | +0.0133 | [0.0000, 0.0300] | no difference |
| R@5 | 0.4067 | 0.4067 | +0.0000 | [-0.0200, 0.0167] | no difference |
| R@10 | 0.4733 | 0.4700 | +0.0033 | [-0.0167, 0.0233] | no difference |
| **recall@budget** | 0.6100 | 0.6000 | **+0.0100** | [-0.0100, 0.0300] | no difference |

Discordant pairs 70/300. **VERDICT: KEEP.** The declared rule gives the
incumbent a tie, and the feature is the incumbent.

## The eviction hypothesis was WRONG, and the returned-set field proves it

**Median memories returned: ON 30, OFF 29.** Error-stickiness ADMITS one more
memory at the median. It does not evict.

Amendment 1 predicted this before the run, off the length profile: hippo's
real error memories are short (median 12 tokens against 53), so promoting them
costs the budget almost nothing. The eviction story was true of the Jev arm,
which tagged rows of median 98 tokens. It is not true of the feature.

This is the field Stage 5.7 finding 8 said was missing. Adding it turned a
guess into a measurement.

## Strata, at the declared Bonferroni alpha 0.025

**E — target IS error-tagged, n=127**

| metric | ON | OFF | delta | 97.5% CI | read |
|---|---|---|---|---|---|
| R@1 | 0.2598 | 0.2205 | +0.0394 | [0.0079, 0.0866] | **HELPS** |
| R@5 | 0.4882 | 0.4567 | +0.0315 | [0.0000, 0.0709] | no difference |
| **recall@budget** | 0.6614 | 0.6142 | **+0.0472** | [0.0157, 0.0945] | **HELPS** |

**N — target is NOT error-tagged, n=173**

| metric | ON | OFF | delta | 97.5% CI | read |
|---|---|---|---|---|---|
| R@1 | 0.1792 | 0.1850 | -0.0058 | [-0.0231, 0.0000] | no difference |
| R@5 | 0.3468 | 0.3699 | -0.0231 | [-0.0520, 0.0000] | no difference |
| **recall@budget** | 0.5723 | 0.5896 | **-0.0173** | [-0.0405, 0.0000] | no difference |

The confirmatory secondary on E PASSES. The one on N does not: every stratum-N
interval has 0.0000 as its upper bound, i.e. the loss never clears the
declared bar. At the nominal 95% level R@5 on N reads -0.0231
[-0.0462, -0.0058] and would have been called a loss. **The declared alpha is
the one that counts, and it was declared before the run.** Both are printed.

## The exchange rate, in counts

Across 300 queries, stickiness FINDS **6.0** error memories that would
otherwise be missed and LOSES **3.0** ordinary ones. Two found per one given
up. It pays off if an error memory is worth more than half an ordinary one.

That is a judgement, not a measurement, and it is the user's to make. Given
that the feature exists because error memories are believed to be worth MORE,
2:1 clears the bar comfortably.

## Honest scale

These are small counts. The stratum N "loss" is **3 queries out of 173**; the
stratum E gain is **6 out of 127**. Nothing here is a large effect, and the
pooled primary is a tie. The finding is not "stickiness is great", it is
**"stickiness is roughly free, and slightly positive where it is aimed"**.

## The placebo, and the confound that killed its first answer

The first placebo run said, across 20 replays with 18 clean separations and 2
ties: *"Boosting error rows costs stratum N 0.0173 MORE than boosting the same
number of equally long non-error rows. Errorness carries the loss, not length."*

**That answer was an artifact and is retracted.**

Checked before reporting it: **140 of the 173 stratum-N targets, 81%, were
inside the boost-other pool.** At a 70% subsample the placebo's control arm was
promoting about 98 of the 173 memories it was then scored on finding. The
error arm structurally cannot do this, because stratum-N targets are by
definition not error-tagged. The separation was self-promotion, not mechanism.

Fixed by barring all 300 query targets from BOTH pools
(`scripts/hippo-error-stickiness-ab.mjs`, placebo block). Re-run, 20 replays:

| arm | stratum N delta, median | p5 | p95 |
|---|---|---|---|
| boost 376 ERROR rows | 0.0000 | -0.0058 | 0.0000 |
| boost 376 LENGTH-MATCHED others | -0.0058 | -0.0116 | 0.0000 |

The distributions overlap completely and both sit at zero to within one query.
**At matched length and matched count, boosting error rows is not
distinguishable from boosting anything else.** The small stratum-N cost is
generic displacement, with no contribution from errorness.

**Declared-threshold ruling: the placebo does NOT carry verdict weight.**
Excluding the targets shrank the match to 538 pairs at a median gap of 4
tokens against a median error length of 12. The pre-registered bar was a gap
no greater than 25% of 12, i.e. 3. Four exceeds three, so by Amendment 1's own
rule this placebo is **TOO WEAK, diagnostic only**. It agrees with the primary
and it does not get to vote. That threshold was set before the run precisely
so this call could not be made after seeing the number.

## What Lane 8 changes

Nothing ships. The feature stays as it is, now with a measurement behind it
rather than an assumption. The eviction risk that motivated the lane is real
physics but does not fire here, because the memories hippo favours are small.

It WOULD fire for any future mechanism that promotes long memories. That is
the transferable result, and it is what sank the Jev arm.

---

# CORRECTION 1 — the store-wide classification number does not measure Jev

Raised by Keith, 2026-09-18: "did you install jev correctly?" The install was
audited rather than defended. It is correct. The published store-wide number
is not.

## The install audit

`scripts/jev-classify-eval.mjs:54-57` posts to the documented endpoint with
Bearer auth and the documented body `{state, model, questions}` on
`jev-latest`, matching `src/judgment.ts`. Lanes 3 and 4 do NOT use
`src/judgment.ts`; they carry their own inline prompt, so the `durable` and
`kind` wording in that file never ran and cannot explain anything here.

The target question is asked directly as a `noul` (`:36`) and read straight
off the wire with no transformation (`:62`, `p = answers.isError.noul`).

Response health on the full-store run: **0 failed calls in 1917**, `p` spread
over 98 distinct values from 0.01 to 0.98, `kindConfidence` over 90. Nothing
degenerate, clamped, or defaulted.

## What is actually broken: the label

AUC against the `error` tag, measured WITHIN each source family. The keyword
regex column is a Jev-free measurement of whether the label carries any text
signal at all.

| family | n | error rate | keyword | length | Jev |
|---|---|---|---|---|---|
| shared | 1118 | 75% | 0.487 | 0.365 | 0.607 |
| cli | 310 | 42% | 0.598 | 0.413 | **0.883** |
| capture | 157 | 21% | 0.396 | 0.625 | 0.724 |
| consolidation | 72 | 67% | 0.469 | 0.472 | 0.534 |
| cli-global | 41 | 34% | 0.689 | 0.608 | **0.981** |
| claude-memory | 208 | 0% | n/a | n/a | n/a |

In `shared`, the largest family and 58% of the store, a regex containing the
literal words error, fail, broke, bug and crash scores 0.487 against the error
tag. A coin flip. That is a property of the labels with the model switched
off, and no text classifier can beat it.

The ordering holds without exception: wherever the free baseline says the
label carries text signal, Jev extracts far more of it; wherever the baseline
says it carries none, Jev is near chance too. That is the signature of a
working instrument on a broken label, not a broken instrument.

Sampled `shared` rows tagged `error` include "auto-revoke old distribution
certificates before creating new one", "resolve login redirect loop on fresh
install" and "hidden wellness pagination". These are fix-shaped task titles.
They are tagged error because of the WORK they came from, not because the text
describes a failure. `claude-memory` carries the tag on 0 of 208 rows.

## The retraction

**Store-wide AUC 0.554 is withdrawn as a verdict on Jev.** It is an average
over a label that is text-unpredictable in its largest family. It measures
hippo's tag hygiene.

The numbers that measure Jev are the within-family ones on the families where
the tag means what it says: **0.883 on cli** (matching the untouched Lane 4
holdout at 0.891) and **0.981 on cli-global**.

This does NOT revive the retrieval lanes. Lanes 6 and 7 failed on retrieval
metrics against a token budget, and the Lane 8 mechanism explains why: Jev
promotes long memories (median 98 tokens) that displace short ones. A correct
classifier still loses that trade. DO NOT SHIP stands for retrieval.

## New finding, owed to hippo not to Jev

835 `shared` rows carry an `error` tag that no text signal supports, and
`src/memory.ts:394` doubles the half-life of every one of them. Lane 8 measured
that physics as roughly free, so this is not urgent, but the tag is load
bearing and in that family it is noise. Open as a hippo data-quality item.

---

# WAVE 2 PRE-REGISTRATION — Lanes 9 to 12

Written 2026-09-18 BEFORE any Wave 2 call, at Keith's ask for more evals and
benchmarks with and without Jev. Nothing below is edited after a result lands.

## Why these lanes and not more of the last ones

Lanes 5, 6 and 7 all did the same thing: take Jev's CONTEXT-FREE `isError`
score, use it to add an `error` tag, and let the half-life physics reorder
retrieval. Jev never saw the query. A decision model used as a static prior is
the weakest available wiring, and the vendor's own guidance is the opposite:
build the candidate list in code, then ask a typed question about THIS choice.

Lane 1+2 already tested the write gate (`durable` vs usefulness) and FAILED at
AUC 0.534 against a length baseline at 0.655. It is not re-run.

## Lane 9a — query-conditioned CHOICE rerank

One call per query. `state` carries the query plus hippo's own top-20
candidates, numbered. One `choice` question over those 20 ids: which single
memory best answers the query. Candidates built in code, so it cannot invent.

- Population: the 300 paraphrase cases, `evals/paraphrase/queries*.json`
- Arms: hippo base ranking, vs hippo with Jev's pick hoisted to rank 1
- PRIMARY: **R@1**. Secondary: MRR
- Hard ceiling: recall@20 of the base arm. Jev cannot recover a target hippo
  never surfaced, and any R@1 gain is reported against that ceiling
- Cost: ~300 calls, ~$0.12

## Lane 9b — query-conditioned per-pair NOUL rerank

One call per (query, candidate) pair over the top 15. `noul`: probability this
memory helps answer this query. Full reorder of the candidate set by that score.

- PRIMARY: **recall@budget** at hippo's real 4000-token cut (`search.ts:410`)
- Secondary: R@1, R@5
- Cost: ~4500 calls, ~$1.80

## Lane 10 — length-normalised promotion, $0, no API

Re-uses the Lane 3 scores already on disk. Promotes by `p / sqrt(tokens)`
instead of `p`. Attacks the one mechanism Lanes 6-8 proved: Jev favours long
memories and hippo cuts on a token budget.

- Arms: base, raw-p promotion (the Lane 7 arm), length-normalised promotion
- PRIMARY: **recall@budget**

## Lane 11 — cost and latency, reported not gated

Wall-clock ms and USD per query for each arm above, beside the accuracy delta.
A retrieval win that costs 2 seconds a query is a different product decision
from one that costs 40ms. Diagnostic; it cannot flip a verdict, only inform it.

## Decision rule

Three confirmatory lanes (9a, 9b, 10), so **Bonferroni alpha 0.0167** and CIs
are reported at 98.33%. A lane SHIPS only if its primary CI excludes zero
upward at that alpha AND it does not lose on its secondary. A tie promotes the
incumbent by parsimony. Paired bootstrap, 2000 draws, query as the resampling
unit, one resample matrix per report.

**This verdict is only as good as this rule. Attack the rule, not just the
numbers.**

## Trial ledger

Wave 2 takes the campaign from N=8 to **N=12** verdict lanes. At alpha 0.05
that is 0.6 expected false passes across the campaign; at the Bonferroni 0.0167
used here, 0.2. Any single pass is read against that.

## Prediction, recorded before the runs

Written now so it cannot be tuned later.

1. **Lane 9a HELPS.** This is the first time Jev sees the query, it is the
   vendor's stated sweet spot, and picking one of twenty supplied options is a
   far easier question than scoring a memory in isolation.
2. **Lane 9b is a coin flip.** Per-pair scoring re-opens the length channel
   that sank Lanes 6 and 7, and this time there is no tag physics to blunt it.
3. **Lane 10 FAILS.** Lane 8 measured the exchange rate at roughly 2:1 with a
   pooled tie; normalising by length should not be enough to clear a
   Bonferroni bar.

If 9a passes and 9b fails, the honest reading is that Jev is a good SELECTOR
and a bad SCORER, and hippo should call it once per query, not once per
candidate.

## AMENDMENT 2 to Wave 2, written before the first call

Two defects in the Lane 9b design above, both found by reading it back rather
than by seeing a result. Recorded rather than silently corrected.

**Defect 1: the depth was inside the cut.** Lane 9b declared a top-15 rerank
with `recall@budget` as PRIMARY. Hippo's 4000-token budget admits a median of
28 to 30 memories, so a top-15 reorder happens entirely inside the admitted
set and cannot change recall@budget by construction. The metric could only ever
have printed zero. **Candidate depth is raised to 40**, which straddles the cut,
so reordering can push a memory across it in either direction.

**Defect 2: the call pattern ignored the vendor's own guidance.** Per-pair
calls at depth 40 would be 12,000 calls and about $4.80. Questions batched into
one call run in parallel and output tokens are free, so Lane 9b instead sends
ONE call per query: `state` carries the query plus all 40 numbered candidates,
and 40 `noul` questions ask about each in turn. 300 calls, about $0.12.

This makes the batching claim itself testable, so it is declared here as a
gate rather than an assumption:

**Batch-integrity check, run on 5 queries before the full lane.** The response
must carry all 40 answers, and their spread must be non-degenerate (more than
5 distinct values, not all equal, not all 0.5). If it fails, Lane 9b falls back
to per-pair calls at depth 40, the cost rises to about $4.80, and the failure is
reported as a finding about the API rather than buried as a retry.

**Wave 2 cost ceiling: $6.00.** A lane that would exceed it stops and reports.

## AMENDMENT 3 — Lane 12, the arm that was missing from the whole campaign

Found on the main thread while Wave 2 was running, by grepping `src/` rather
than by any result. Recorded before Lane 12 runs.

**Hippo already ships a reranker.** `src/rerankers/index.ts` registers two:
`cross-encoder` (`src/rerankers/cross-encoder.ts`, the local
`Xenova/ms-marco-MiniLM-L-6-v2` model, free, no network) and `llm`
(`src/rerankers/llm.ts`, an explicit skeleton gated on
`HIPPO_LLM_RERANKER_URL`). Neither transformers package is installed here, so
the cross-encoder has never been run on this box.

Every lane in this campaign has therefore asked the wrong question. "With Jev
versus without Jev" compares a paid hosted model against NOTHING. The decision
Keith actually faces is whether to pay for Jev when a free local reranker is
already in the package. A Jev win over the empty arm is not a reason to ship
Jev; it is a reason to turn on whichever reranker wins.

**Lane 12** adds the missing arm: the same 300 paraphrase queries, the same
depth-40 candidate sets, hippo's own `cross-encoder` reranker, the same
`recall@budget` primary and the same 98.33% CIs.

The three-way surface, all paired on one query set:

| arm | cost per query | network |
|---|---|---|
| no rerank | $0 | none |
| cross-encoder | $0 | none, local model |
| Jev | ~$0.0004 | hosted |

**Cross-script control.** Lane 12 recomputes the base arm independently. If its
base recall@budget does not match Lane 9b's base to within bootstrap noise,
the two scripts disagree about the incumbent and NEITHER result is reported
until that is explained.

**Decision rule, extended.** Jev ships only if it beats the cross-encoder, not
merely the empty arm. Beating nothing while losing to a free local model is
recorded as DO NOT SHIP. This raises the confirmatory count to 4, so the
Bonferroni alpha tightens to **0.0125** and CIs are reported at **98.75%**.
Lanes 9a, 9b and 10 are re-read at the tighter alpha; a lane that passed only
at 0.0167 is demoted to a flag.

Installing `@xenova/transformers` is a local dev dependency change, reversible,
and does not touch the published package surface.

---

# LANE 10 RESULT — length-normalised promotion. DO NOT SHIP.

n=300 paraphrase queries, K=1058 promoted of 1901 labelled rows, $0, no API.
Matches the pre-registered prediction 3 written before the run.

## Contrast A, lennorm vs base

| metric | base | lennorm | delta | 98.33% CI | read |
|---|---|---|---|---|---|
| **recall@budget** | 0.6100 | 0.6133 | +0.0033 | [-0.0133, 0.0233] | no difference |
| R@1 | 0.2100 | 0.2267 | +0.0167 | [0.0033, 0.0367] | secondary only |
| R@5 | 0.4033 | 0.4200 | +0.0167 | [-0.0033, 0.0400] | no difference |
| MRR | 0.3045 | 0.3155 | +0.0110 | [0.0013, 0.0236] | secondary only |

## Contrast B, lennorm vs raw-p: did normalising help

| metric | raw-p | lennorm | delta | 98.33% CI | read |
|---|---|---|---|---|---|
| **recall@budget** | 0.5933 | 0.6133 | +0.0200 | [-0.0033, 0.0467] | no difference |
| R@1 | 0.2233 | 0.2267 | +0.0033 | [-0.0133, 0.0200] | no difference |
| R@5 | 0.4267 | 0.4200 | -0.0067 | [-0.0300, 0.0167] | no difference |
| MRR | 0.3143 | 0.3155 | +0.0013 | [-0.0097, 0.0118] | no difference |

## The mechanism was fixed and it bought nothing

Normalising changed WHICH rows got promoted, sharply: 767 of 1058 ids overlap,
so 291 differ each way, and the median promoted length falls from **54 tokens
to 17**. The eviction signature moves with it. Median returned-set size is 30
for base, **28 for raw-p**, and back to **30 for lennorm**. Raw-p was indeed
eating the token budget with long rows, and dividing by sqrt(tokens) stops it.

And the repair lands exactly back on the baseline. All three arms tie.

**The load-bearing reading is not "length caused the loss".** It is that the
context-free Jev score carries no usable retrieval signal at all. Promote by
`p`, promote by `p/sqrt(tokens)`, or promote nothing, and retrieval is the
same. The length confound was real, and fixing it revealed there was nothing
underneath it. This supersedes the softer Lane 7 reading.

The two secondary wins against base (R@1, MRR) do not feed the ship rule and do
not survive Contrast B, where they are flat. They are reported, not claimed.

Ledger: N=9 of 13.

---

# LANE 9 RESULT — query-conditioned rerank. 9a SHIPS. 9b's metric is void.

n=300, 0 failed calls, 0 retries, $0.24 total. Amendment 2 batch gate PASSED
5 of 5: every probe returned all 40 noul answers with 13 to 33 distinct values.

## Lane 9a, choice rerank: the real result

| metric | base | Jev | delta | 98.33% CI | read |
|---|---|---|---|---|---|
| **R@1** | 0.2633 | 0.5967 | **+0.3333** | **[0.2633, 0.4067]** | **JEV WINS** |
| MRR | 0.3648 | 0.6328 | +0.2680 | [0.2096, 0.3316] | JEV WINS |

Ceiling: base recall@40 = 0.7467. A quarter of targets never reach hippo's own
top 40 and no rerank can recover them. Conditional on the target being in the
pool, **Jev picks it 79.9% of the time** (179 of 224).

**Leakage survived.** The paraphrase queries are generated FROM their targets,
so a semantic matcher could in principle be matching a paraphrase to its source
rather than doing retrieval. Re-ran on the 294 rows the harness does NOT flag
for shared spans or rare-token overlap: delta **+0.3333 [0.2585, 0.4116]**,
identical to three decimal places. Leakage is not carrying this.

## Lane 9b: NO VERDICT, the metric is broken

Reported +0.0500 [0.0200, 0.0867] on recall@budget. It does not count, for two
reasons found on the main thread after the run, not by the runner.

**1. It is not hippo's metric.** Lane 9b REIMPLEMENTS the budget cut
(`design_notes`: "replicates search.ts:777-788") over a truncated 40-item list.
Lane 10 called the real `hybridSearch` with no override over all 1933 entries.
The two disagree on the same base arm on the same 300 queries:

| | Lane 10 (real search) | Lane 9b (reimplemented) |
|---|---|---|
| base recall@budget | 0.6100 | 0.6967 |
| base R@1 | 0.2100 | 0.2633 |

The reconstruction runs 8.7 points permissive. This is the cross-script control
from Amendment 3 firing, one lane earlier than expected.

**2. It is saturated.** Lane 9b's Jev-arm recall@budget is 0.7467, which is
EXACTLY the recall@40 ceiling. Whenever the target was in the 40, the reorder
put it inside the cut, every single time. A metric pinned to its own ceiling
cannot distinguish a good rerank from any rerank.

Lane 9b's R@1 and R@5 are rank-derived and sound, but they re-measure what 9a
already measured. **Lane 9b is withdrawn as a verdict lane.** The operational
question it was meant to answer is reopened and must be re-run through hippo's
actual search path, not a replica.

## The caveat that matters operationally: Jev does not abstain

76 of 300 queries had no valid answer in the candidate pool. Jev picked one
anyway, every time, at **mean confidence 0.543**, and **9 of those 76 (11.8%)
came back at confidence 0.85 or higher**. The vendor's own guidance is to gate
irreversible actions at 0.85+. On this evidence that threshold does not filter
unanswerable questions, so any wiring needs a separate reachability check
rather than trusting confidence alone.

## Prediction scorecard

Prediction 1 (9a helps): **right**, and understated. Prediction 2 (9b a coin
flip): **unresolved**, the metric was too weak to judge, which is a worse
outcome than being wrong. Prediction 3 (Lane 10 fails): **right**.

Ledger: N=10 of 13, with 9b withdrawn rather than counted.

## Recon finding: LongMemEval is live and was wrongly written off

`benchmarks/longmemeval/` holds the real dataset (oracle 15MB, S 277MB) and
`retrieve_inprocess.mjs` ALREADY accepts `--reranker`, importing `getReranker`
from `dist/rerankers/index.js`.

This protocol disqualified it earlier on the grounds that Jev scores 0 of 50
LongMemEval memories above p=0.3, the corpus being personal chat with no
engineering errors. **That disqualification applied to the isError prior and
does not transfer.** Lane 9 asks a query-conditioned relevance question, which
has nothing to do with errorness. LongMemEval is a valid instrument for a
relevance reranker and is hereby RE-QUALIFIED for that use only.

That makes the external benchmark reachable: write `src/rerankers/jev.ts`,
register it, and run LongMemEval three ways (none, cross-encoder, jev). Held
until Lane 12 finishes to avoid two agents colliding on `npm install` and a
shared `dist/` build.

---

# LANE 12 RESULT, AND THE BUG IT EXPOSED (2026-09-18)

## Lane 12 as run: VOID, not "flat"

Every metric came back at exactly +0.0000 with zero-width intervals:
recall@budget, R@1, R@5 and MRR, all 0.6967 / 0.2633 / 0.4600 / 0.3608 in both
arms, all 300 per-query deltas identically zero.

That is not a null result. **hippo's shipped cross-encoder reranker was a
no-op.** `ceScore` is exactly `1` for all 224 target rows in
`results/crossenc-rerank-ab-2026-09-18.json`, and a deliberately nonsense probe
pair scored 1.0 too.

## Root cause, verified in the installed library

`src/rerankers/cross-encoder.ts:87` requested a `text-classification` pipeline.
`node_modules/@xenova/transformers/src/pipelines.js:296` applies
`softmax(batch.data)` for a single-label head. `ms-marco-MiniLM-L-6-v2` is a
`num_labels=1` regression head, so that vector has length 1, and **softmax over
a one-element vector is identically 1.0 for any logit**: `exp(x)/exp(x)`. Not
saturation, an algebraic identity, which is why the score was bit-exact across
every input.

Second defect: `cross-encoder.ts:89` passed `query [SEP] candidate` as ONE
sequence, so token_type_ids were all 0 rather than the 0/1 segment pair the
model was trained on.

Third defect, the reason this shipped unseen: the test availability probe at
`tests/rerankers/cross-encoder.test.ts:29-30` compared `rerankScore` against an
input score of `1.0`, so "model unavailable" and "model returned 1.0" were the
same observation. The detector was blind to exactly this failure.

## Fix (applied at root, all three)

Load `AutoTokenizer` + `AutoModelForSequenceClassification` directly, tokenize
query and candidate as a true `text_pair`, read `logits.data[0]` raw, and
sigmoid it. Sigmoid is monotone so it preserves the cross-encoder's ordering,
and it keeps the value in the [0,1] range the downstream `--goal`/salience
sorters assume (`cli.ts:1444` copies `rerankScore` into `score`; raw ms-marco
logits go negative and would sink the reranked head below the untouched tail).
The test probe now scores a matching and a nonsense candidate and requires them
to DIFFER.

Post-fix discrimination check, same query, four candidates:

| score | candidate |
|---|---|
| 0.982818508748 | Production deployment runbook: run scripts/deploy.sh after CI passes |
| 0.0000764882999 | The word production appears in many places |
| 0.0000110343971 | zebra hovercraft telephone banana |
| 0.0000110122472 | My cat is asleep on the radiator |

Four distinct scores, correct order, and the lexical decoy correctly buried.

## What this does to the campaign

Amendment 3 tightened the rule to "Jev ships only if it beats the
cross-encoder". **That gate has been unfalsifiable for the whole campaign**,
because the comparator provably did nothing on every input. Lane 12's
DO-NOT-PROMOTE verdict is withdrawn. The lane must be re-run against a working
cross-encoder before any Jev promotion decision stands.

Ledger: Lane 12 as run does not count as a trial. N stays at 10 of 13.

---

# WAVE 3 PRE-REGISTRATION (Lanes 13-14), declared 2026-09-18 before either run

Alpha stays 0.0125 (Bonferroni over the wave). Paired bootstrap, 2000 draws,
query as the resampling unit, as in every prior retrieval lane.

## Lane 13: Lane 12 re-run against the REPAIRED cross-encoder

Same 300 paraphrase queries, same NOW pin, same base arm, depth 40. Primary
metric R@1, secondary recall@budget, R@5, MRR. Cost $0 (local model).

**Prediction, declared before the run:** the repaired cross-encoder beats base
on R@1 by a positive margin, but by LESS than Jev's +0.3333. Stated reason: a
3-line-per-candidate ms-marco model is strong at lexical-plus-semantic matching
but these queries are paraphrases whose targets are often short config notes,
which is Jev's demonstrated strength and a cross-encoder's known weak spot.

## Lane 14: LongMemEval, three arms, external corpus

`benchmarks/longmemeval/retrieve_inprocess.mjs --reranker {none,cross-encoder,jev}`
on the oracle split. This is the first lane in the entire campaign run on data
hippo's own store did not generate, so it is the only lane that can rule out
store-specific overfitting.

Primary metric: recall@k as the harness already defines it. Cost: one batched
call per question for the Jev arm only, about $0.20 at the vendor's ~$0.0004,
inside the declared $6.00 Wave 2 ceiling ($0.24 spent to date).

**Prediction, declared before the run:** Jev's advantage SHRINKS materially
versus the +0.3333 seen on hippo's own store. Stated reason: the paraphrase
queries were generated from their targets, and although the leakage check held
on hippo data, LongMemEval questions are written independently of the haystack.
A three-arm design is declared precisely so a shrunk Jev number can still be
read against a working local baseline rather than against nothing.

**Integrity gate (both lanes):** if any arm returns byte-identical rankings to
the base arm across all queries, that arm is reported VOID rather than flat,
and the Lane 12 failure mode is the first hypothesis checked. A zero-width
confidence interval is treated as a defect signal, never as a precise null.

---

# LANE 13 RESULT + GATE CORRECTION (2026-09-18)

## The gate I declared was mis-specified. Correcting it, not the run.

Lane 13's declared gate said any difference in the five base-arm control
numbers voids the comparison. Two of five differed, and the lane was correctly
reported VOID under that rule. **The rule was wrong.**

| metric | Lane 12 | Lane 13 | |
|---|---|---|---|
| median returned-set size | 33 | 33 | match |
| recall@budget | 0.6967 | 0.6967 | match |
| R@1 | 0.2633 (79/300) | 0.2600 (78/300) | differs |
| R@5 | 0.4600 | 0.4600 | match |
| MRR | 0.3608 | 0.3584 | differs |

Cause, verified: `scripts/crossenc-rerank-ab.mjs:42` is
`const NOW = new Date(); // pinned once so recency decay cannot drift mid-run`.
It pins WITHIN a run only. Lane 12 ran at 14:31:52.073Z, Lane 13 at
14:57:39.931Z, and `search.ts:116` scores recency on `now - created`.

Note for future lanes: setting `HIPPO_FAKE_NOW` does NOT fix this script.
`search.ts:409` is `options.now ?? evalNow()`, and line 43 passes `now: NOW`
explicitly, short-circuiting the `??` before `evalNow()` runs. The fix is a
literal constant in the script, or removing `now` from `SEARCH_OPTS`.

**Why the gate was wrong:** the drift is exactly ONE query of 300 on R@1, both
set-membership metrics reproduced bit-exact, and the treatment effect is 46x
the drift. More importantly Lane 13's contrast is WITHIN-RUN PAIRED: both arms
share one NOW, one query set, one bootstrap pairing, so cross-run base drift
cannot reach it. The gate was written for the Lane 9b failure mode, a replica
harness disagreeing with real search by 8.7 points. Cross-run reproducibility
and internal paired validity are different properties and the gate conflated
them.

**Revised rule, in force from here:** a base-arm control mismatch voids a lane
only when the mismatch is (a) larger than the treatment effect, or (b) caused
by a harness that reimplements rather than calls hippo's search path.
Otherwise it is reported as a drift note beside the result.

## Lane 13 result: the repaired cross-encoder WORKS

| metric | base | cross-enc | delta | 98.75% CI |
|---|---|---|---|---|
| recall@budget | 0.6967 | 0.7400 | +0.0433 | [0.0133, 0.0767] |
| R@1 | 0.2600 | 0.4133 | **+0.1533** | [0.0833, 0.2233] |
| R@5 | 0.4600 | 0.6133 | +0.1533 | [0.0833, 0.2233] |
| MRR | 0.3584 | 0.5086 | +0.1503 | [0.0934, 0.2047] |

Non-degeneracy, the check Lane 12 failed: **224 distinct ceScore values**
(min 0.000011, max 0.998390, zero ties) where the buggy build produced 1.
Top-1 identity changed on 200 of 300 queries. Of 224 in-pool targets, 113 moved
up, 40 down, 71 stayed. Model load 264ms, per-query rerank median 259ms over 40
candidates, $0.

Prediction check: declared "beats base, by less than Jev's +0.3333". Outcome
+0.1533. **Right on both halves** — but see the caveat below before treating
that as a head-to-head.

## The head-to-head has still never been run

Jev's +0.3333 came from `scripts/jev-rerank-query.mjs`. The cross-encoder's
+0.1533 came from `scripts/crossenc-rerank-ab.mjs`. **Different harnesses.**
Comparing across scripts is precisely the error that voided Lane 9b, where a
replica ran 8.7 points permissive against the real search path.

So Amendment 3's gate, "Jev ships only if it beats the cross-encoder", is STILL
not decided. It was undecidable before because the comparator was dead; it is
undecidable now because the two numbers come from different instruments.

Ledger: N=11 of 13 (Lane 13 counts, Lane 12 does not).

---

# LANE 15 PRE-REGISTRATION, declared before the run

One script, three arms, one query set, NOW pinned to a literal. This is the
deciding lane for the campaign and the only one that can settle Amendment 3.

Design: `scripts/rerank-3arm-ab.mjs`, NOW pinned to
`2026-09-18T14:31:52.073Z` (Lane 12's clock, so results stay comparable to
recorded evidence), same 300 paraphrase queries, depth 40, arms
base / cross-encoder / jev scored on identical candidate sets. Paired
bootstrap, 2000 draws, query as resampling unit, all three pairwise contrasts
reported. Primary R@1. Alpha 0.0125. Cost about $0.12 for the Jev arm.

**Prediction, declared before the run:** Jev beats the repaired cross-encoder
on R@1, but the margin is SMALLER than 0.3333 - 0.1533 = 0.18, because part of
each script's measured delta is harness-specific rather than model-specific.
Second prediction: the jev-vs-crossenc interval EXCLUDES zero. If it includes
zero, a free local model matches a paid API and Jev does not ship.

## Lane 15 result: Jev clears the declared gate, and the gate was the wrong one

`results/rerank-3arm-2026-09-18.json`, n=300, one script, one NOW, paired.

| metric | base | cross-enc | jev | jev - ce | 98.75% CI | |
|---|---|---|---|---|---|---|
| recall@budget | 0.6933 | 0.7400 | 0.7467 | +0.0067 | [0.0000, 0.0200] | TIED |
| R@1 | 0.2600 | 0.4133 | 0.6167 | **+0.2033** | [0.1333, 0.2733] | WINS |
| R@5 | 0.4600 | 0.6133 | 0.7400 | +0.1267 | [0.0800, 0.1767] | WINS |
| MRR | 0.3584 | 0.5086 | 0.6719 | +0.1633 | [0.1134, 0.2168] | WINS |

Integrity: cross-encoder 11,967 / 12,000 distinct scores (224 / 224 distinct on
in-pool targets); Jev 97 / 12,000 distinct, range 0.01 to 0.97; 300 / 300 HTTP
ok, zero fallbacks; top-1 changed on 200 / 300 for both arms. Latency p50 295ms,
p90 414ms, max 953ms. Cost $0.12.

**Prediction check: WRONG on the first half.** I declared the margin would land
under 0.18. It was +0.2033. Right that the interval excludes zero.

**The declared primary metric was mis-chosen, and this is the finding.** R@1 was
declared primary before anyone asked what hippo actually injects. Hippo does not
inject one memory; it injects everything that fits a token budget. The metric
that describes the product is `recall@budget`, and on that metric Jev vs the
cross-encoder is +0.0067 with a lower bound of exactly 0.0000. Jev cleared a
gate that does not measure the product.

## Lane 14 result: the cross-encoder win does not generalise

`results/longmemeval-3arm-2026-09-18.json`, n=500, external corpus, same three
arms, `hippo_store2` (1064 memories, local embeddings).

| metric | base | cross-enc | jev |
|---|---|---|---|
| R@1 | 0.512 | 0.528 | 0.598 |
| R@3 | 0.678 | 0.692 | 0.728 |
| R@5 | 0.748 | 0.742 | 0.780 |
| R@10 | 0.828 | 0.816 | 0.844 |
| answer_in_content@5 | 0.486 | 0.470 | 0.482 |

**cross-encoder vs base: nothing significant. All five intervals cross zero, and
three of five point estimates are negative.** On Keith's store the same arm gave
+0.1533 R@1 with a clean interval. Likely driver: base R@1 is 0.26 on Keith's
store against 0.512 here, so there is far less room to rerank. The 0.1533 is a
property of that store and must never be quoted as a general figure.

jev vs base: only R@1 survives, +0.0860 [0.0240, 0.1480]. jev vs cross-encoder:
only R@1, +0.0700 [0.0200, 0.1200]; R@5 lands at +0.0380 [0.0000, 0.0740] and
scores tied on the declared rule.

Gate 1: 0 / 500 byte-identical to base for both arms. Gate 2: cross-encoder
24,888 / 25,000 distinct; Jev 98 / 25,000 distinct, range 0.01 to 0.98, 500/500
HTTP 200. **`confidence` returned 0 times in 500 calls** — `noul` answers carry
no confidence field, so no escalation threshold exists on this question type.
Cost declared $0.20, actual $0.20.

## AMENDMENT 3 VERDICT

Amendment 3 asked: does Jev beat the repaired cross-encoder, measured on one
instrument? **Yes, on ranking, on both corpora.** +0.2033 R@1 on Keith's store,
+0.0700 on LongMemEval. It is the only effect in this campaign that replicates
across corpora.

**And it does not clear the product.** Neither reranker moves the metric that
measures whether the answer reaches the model: Lane 15 `recall@budget` ties at a
lower bound of exactly zero, Lane 14 `answer_in_content@5` ties in all three
contrasts. Both corpora agree on that negative result.

Ledger: N = 13 of 15 (Lanes 12 and 9b do not count). Expected false passes at
alpha 0.0125: 0.16.

## Free re-analysis: injection depth, computed from stored ranks

Recomputed from `rows` in the Lane 15 file, zero API calls. Memories hippo must
inject to reach a given hit rate:

| target | base | cross-enc | jev |
|---|---|---|---|
| 50% | 7 | 2 | 1 |
| 60% | 15 | 4 | 1 |
| 70% | never within 40 | 13 | 2 |
| ceiling at 40 | 0.6933 | 0.7400 | 0.7467 |

All three arms plateau within half a point. They differ almost entirely in how
fast they get there. **This was never declared, so under Stage 2 it is a
diagnostic and cannot carry a verdict — and it is the most useful number the
campaign produced.** Amendment 4 exists to fix exactly that.

---

# AMENDMENT 4 — Wave 3 pre-registration, written before the first run

## Why these four lanes and not a ninth reranking lane

Eight lanes have now measured retrieval quality. The pinned campaign rule says
ten runs of one construct with no new mechanism is a stop, not a result. A ninth
reranking lane would be that. Every lane below tests a mechanism the campaign
has never touched, and the three-line justification for each is: it answers a
question the gate surface left open.

**Every lane in Wave 3 costs $0 in cash.** No Jev calls, no paid API. Lanes 18
and 19 are pure computation over files already on disk. Lanes 16 and 17 need
answer generation, which runs through Sonnet sub-agents on session budget, not
a metered API. `TYPESAFE_API_KEY` and `ANTHROPIC_API_KEY` are both absent from
Process scope in this session, which is checked and recorded here per the
standing credential rule rather than discovered mid-run.

## Lane 16 — does better ordering produce better ANSWERS?

**The question eight lanes have not asked.** Every metric so far is a retrieval
proxy. Nobody has checked whether a model given Jev-ordered context answers more
questions correctly than a model given base-ordered context.

The mechanism being tested is position sensitivity: a model attends unevenly
across its context, so a better ORDER can improve answers even when the SET is
identical. If that effect is real, Jev's ranking win converts into a product
win. If it is absent, Jev's ranking win is cosmetic and Option A is correct.

Design: 150 questions drawn from the LongMemEval 500, stratified 25 per
question_type, fixed seed. Three arms, all at **fixed k=5**, context packs cut
from the existing `lane14-*.jsonl` files so no retrieval re-runs. The answering
agent sees the five memories and the question, never the arm label, and arms are
shuffled per question so it cannot infer one from order of presentation.

Primary metric: **exact-answer rate**, gold answer string present in the model's
answer after case and punctuation normalisation. Secondary: token-F1 against
gold. Both graded deterministically in code, no LLM judge, so the grader cannot
drift between arms. Paired bootstrap, 2000 draws, question as unit, alpha
0.0167 for three pairwise contrasts.

**Prediction, declared before the run:** all three arms tie on exact-answer
rate, intervals crossing zero, because `answer_in_content@5` already ties at
k=5 and a model cannot answer from information that is not in the pack. If Jev
wins here anyway, that is a position-sensitivity effect and it is the single
strongest argument for shipping Jev that this campaign could produce.

## Lane 17 — does the compression claim survive end to end?

The depth curve says Jev reaches a 70% hit rate in 2 memories where the
cross-encoder needs 13 and base never gets there inside 40. That is a retrieval
claim. This lane asks whether it holds where it would be spent: **same answer
quality, far fewer tokens.**

Design: same 150 questions, same packs. Arms held at their own equal-hit-rate
depths from the Lane 15 curve: **jev@2, crossenc@13, base@40**. Reports
exact-answer rate AND tokens injected per question.

Primary metric: exact-answer rate, with **tokens injected reported beside it as
a joint verdict**. A tie on answers at a fifth of the tokens is a win for Jev,
and that is declared here rather than decided afterwards. Same bootstrap and
alpha as Lane 16.

**Prediction:** jev@2 ties base@40 on exact-answer rate while injecting roughly
a twentieth of the tokens. If jev@2 loses to base@40, the compression claim is
dead and the depth curve was measuring something the model cannot use.

## Lane 18 — is Jev's 2-decimal ceiling the binding constraint?

Jev quantises `noul` to two decimals: 97 distinct values in 12,000 on Lane 15,
98 in 25,000 on Lane 14. Fifty times the sample moved it by one. That is the
API, not the sample. The open question is whether that ceiling costs ranking
accuracy, or whether two decimals is simply enough.

Design: $0, no API. The 500 x 50 Jev `noul` values are already on disk in
`lane14-jev-capture.json`, and base rank order comes from `lane14-base.jsonl`.
Fuse them: reciprocal-rank fusion and weighted score fusion, sweeping the weight
across a declared grid, breaking Jev's ties with the base retriever's finer
signal. Judged on the same five Lane 14 metrics against Jev alone.

Declared grid: RRF k in {10, 30, 60}, weighted fusion w in {0.1, 0.25, 0.5,
0.75, 0.9}. That is 8 cells, all declared here, and the best cell is reported
beside the 8 x alpha noise bar per the trial-ledger rule.

**Prediction:** fusion beats Jev alone on R@1 by a small margin that does not
clear the interval, because Jev's ties are mostly between candidates that are
genuinely equivalent. If fusion wins clearly, the quantisation IS binding and
the right product is Jev-plus-local, not Jev.

## Lane 19 — is Lane 15's +0.2033 stable, or a seed artifact?

Lane 15 ran one seed (`0xc0ffee`), one pass, 2000 draws. The gate surface lists
"one run, one seed, no process null" as a caution flag. This lane closes it.

Design: $0, no API, recomputed from the 300 stored rows. Re-bootstrap every
Lane 15 contrast across 20 seeds and report the spread of each interval bound.
Then a **label-permutation null**: shuffle the arm labels within each query 200
times and recompute the jev-vs-crossenc R@1 delta, giving the distribution of
the effect under no true difference. The observed +0.2033 is reported against
that null's p99.

**Prediction:** seed spread on the R@1 interval bounds is under 0.02, and
+0.2033 sits far outside the permutation null. If either fails, Lane 15's
verdict is withdrawn and the gate surface is corrected.

## Wave 3 decision rule, declared

Primary for Lanes 16 and 17: **exact-answer rate**, the first metric in this
campaign that measures the product rather than a proxy for it. Ties break to
parsimony, so a tie promotes the free local arm. Lane 17's token count is part
of its verdict, not a footnote. Lanes 18 and 19 cannot promote anything; they
can only demote a standing claim.

Nulls are vetoes: a Wave 3 result that ties does not become a caution flag, it
closes the question. The campaign has enough flags.

Ledger after Wave 3: N = 17. Expected false passes at alpha 0.0167: 0.28.

**This verdict is only as good as this rule — attack the rule, not just the
numbers.** The place to attack it: exact-answer rate against a single gold
string is harsh on questions with several right phrasings, and it will
under-report every arm equally. That is a deliberate choice for a deterministic
grader over an LLM judge that could drift between arms, and it trades
sensitivity for the guarantee that the grader cannot favour one arm.

## Wave 3 results, part 1: Lanes 18 and 19 (written 2026-09-19)

Status: 2 of 4 lanes run. Both cost $0. Lanes 16 and 17 are in the NOT-DONE
table below.

### Lane 19: seed sweep and label-permutation null. Verdict: Lane 15 stands.

Script `lane19_robustness.mjs` (session scratchpad). Output
`results/lane19-robustness-2026-09-18.json`. Regenerate with
`node lane19_robustness.mjs`; it exits 1 unless it reproduces Lane 15 first.

- Sanity gate: all 12 published Lane 15 metrics reproduced to 4 decimals from
  the 300 stored rows.
- Seed sweep, 20 seeds x 2000 draws, 98.75% intervals. jev minus crossenc on
  R@1 is +0.2033. Lower bound ranged 0.1267 to 0.14, upper bound 0.2667 to
  0.2833. Spread 0.0133 and 0.0167, both under the declared 0.02. Significant
  in 20 of 20 seeds.
- Every other contrast that was significant in Lane 15 is significant in 20 of
  20 seeds. jev vs crossenc on recall@budget is tied in 20 of 20 (delta
  +0.0067, lower bound 0 in every seed). That tie is stable too.
- Permutation null, arm labels shuffled within each query, 200 permutations as
  declared: p95 0.0567, p99 0.08, max 0.08. Observed +0.2033. 0 of 200 reach
  it. Labelled diagnostic at 10,000 permutations: p99 0.0733, max 0.1133, 0 of
  10,000 reach it.
- Both predictions held. The upper-bound spread of 0.0167 sits close to the
  0.02 line and is reported as such.

What this closes and what it does not. The gate surface flag read "one run,
one seed, no process null". The seed part is closed. A label null now exists.
Still open: each arm was run once, so Jev's run-to-run variance is unmeasured,
and this is a label-permutation null on stored ranks, not a Stage 5 process
null that re-runs retrieval on information-free inputs.

### Lane 18: fusing Jev's score with the local rank. Verdict: no demotion at the top pick, a demotion below it.

Script `lane18_fusion.mjs` (session scratchpad). Output
`results/lane18-fusion-2026-09-18.json`. Alignment 500 of 500. Base and jev
reproduce Lane 14 to 3 decimals. 98 distinct noul values across 25,000 scores.

| ordering   | R@1   | R@3   | R@5   | R@10  | Ans@5 |
|------------|-------|-------|-------|-------|-------|
| base       | 0.512 | 0.678 | 0.748 | 0.828 | 0.486 |
| jev        | 0.598 | 0.728 | 0.780 | 0.844 | 0.482 |
| rrf_10     | 0.554 | 0.740 | 0.816 | 0.880 | 0.508 |
| rrf_30     | 0.556 | 0.736 | 0.806 | 0.876 | 0.510 |
| rrf_60     | 0.556 | 0.734 | 0.800 | 0.872 | 0.508 |
| wfuse_0.1  | 0.570 | 0.720 | 0.764 | 0.844 | 0.492 |
| wfuse_0.25 | 0.610 | 0.764 | 0.804 | 0.850 | 0.502 |
| wfuse_0.5  | 0.614 | 0.772 | 0.822 | 0.868 | 0.504 |
| wfuse_0.75 | 0.610 | 0.768 | 0.818 | 0.884 | 0.490 |
| wfuse_0.9  | 0.594 | 0.748 | 0.808 | 0.876 | 0.486 |

Each cell against Jev alone, 2000 draws, alpha 0.0167:

- R@1: no cell beats Jev. Best is wfuse_0.5 at +0.016, interval
  [-0.018, 0.050], tied. rrf_10 is worse, -0.044 [-0.086, -0.002]. The
  prediction held: 2-decimal quantisation costs nothing at the top pick.
- Below the top pick, 10 of the 32 recall cells beat Jev with a clean
  interval: rrf_10 (R@5 +0.036, R@10 +0.036), rrf_30 (R@10 +0.032),
  wfuse_0.5 (R@3 +0.044, R@5 +0.042), wfuse_0.75 (R@3 +0.040, R@5 +0.038,
  R@10 +0.040), wfuse_0.9 (R@5 +0.028, R@10 +0.032). Counting the rrf_10 R@1
  loss, 11 of 40 comparisons exclude zero. Expected by chance: 0.1336 per
  metric, 0.67 across all five.
- answer_in_content@5 never clears. Best is rrf_10 at +0.026 [0, 0.052].

Reading, under the declared rule. This lane can only demote. It demotes one
claim: "Jev alone is the best ordering" holds at R@1 and fails at R@3, R@5 and
R@10, where Jev plus the local rank is better. It promotes nothing: the weight
was picked in-sample, the cells share one dataset, and the metric that tracks
the answer (Ans@5) did not move.

### NOT-DONE

| Declared | Status | Why | Slot |
|---|---|---|---|
| Lane 16, answers at equal depth | not run | all 6 answering agents died on the weekly usage limit (HTTP 429); 0 answer files written | packs, blinded shards, key and grader are on disk; needs a yes on usage |
| Lane 17, answers at unequal depth | not run | same; all 10 agents died, 0 answer files | same |
| Stage 5 process null for Lane 15 | not run | needs retrieval re-run on time-shifted inputs | undecided |
| Jev run-to-run variance | not run | each arm was run once | undecided |

Process finding, mine: the first Wave 3 shards were about 1 MB each. An agent
reads a file that size in many chunks and re-reads its whole context on every
chunk, so usage grows with the square of shard size. The shards are now re-cut
to at most 157 kB (`results/wave3/lean/`, 18 files for Lane 16 and 74 for
Lane 17, same item ids, same answer key).

## AMENDMENT 5 (operational, written before the rerun, 2026-09-19): how Lanes 16 and 17 get answered

Nothing about the questions, the arms, the depths, the metrics, alpha or the
decision rule changes. Zero answers existed when this was written.

- Shards are re-cut into `results/wave3/blind-v2/` (20 files for Lane 16, 76
  for Lane 17, `manifest.json` beside them). Script `wave3_reshard.mjs`, seed
  0xB12 + lane. `results/wave3/lean/` from earlier today is superseded and
  unused.
- New constraint: no question appears twice inside one shard. The first two
  cuts allowed it, so an agent could see the answer in one arm's pack and carry
  it into another arm's item. That leak pushes every contrast toward a tie.
  Item ids and the held-back answer key are unchanged.
- One Sonnet agent per shard (model sonnet, effort medium), run as a single
  workflow capped at 16 at a time, Lane 16 first. Each agent reads only its
  shard and writes `results/wave3/lane<lane>-answers-shard-sNN.json`. It never
  sees the key, the packs or an arm label.
- The answering brief is the same for every item: answer from that item's
  memories only; no outside knowledge; exactly `NOT_IN_CONTEXT` when the
  memories lack the answer; otherwise one short direct answer.
- Stop rule: after 6 failed agents the workflow launches no more. Missing
  shards are rerun once with the same brief. A question with any arm still
  missing is dropped from all three arms and counted in the report.
- Grader change: an unreadable answers file is reported and skipped, never
  fatal. Scoring is untouched.
- Cost, stated to Keith and approved before launch: 96 agents, roughly 15M
  tokens, $0 cash.

## Wave 3 results, part 2: Lane 16 done, Lane 17 stopped part-way (written 2026-09-19)

Source: `results/wave3-graded-2026-09-18.json`. Regenerate with
`node results/wave3/scripts/wave3_grade.mjs`. Run cost comes from
`node results/wave3/scripts/wave3_progress.mjs` (reads the agent transcripts).

### Lane 16: answers at fixed k=5 (150 of 150 questions, 0 items missing)

| arm | exact-answer rate | token-F1 | abstain rate | est. tokens |
|---|---|---|---|---|
| base | 0.1067 | 0.1363 | 0.7267 | 1500 |
| crossenc | 0.1533 | 0.1805 | 0.6667 | 1500 |
| jev | 0.1467 | 0.1917 | 0.6200 | 1500 |

| contrast | exact-answer rate (primary) | token-F1 (secondary) |
|---|---|---|
| crossenc vs base | +0.0467 [0.0133, 0.0867] significant | +0.0442 [0.0046, 0.0935] significant |
| jev vs base | +0.0400 [-0.0067, 0.0933] tied | +0.0554 [0.0078, 0.1105] significant |
| jev vs crossenc | -0.0067 [-0.0533, 0.0400] tied | +0.0112 [-0.0320, 0.0591] tied |

The same answer came back in all three arms for 104 of 150 questions.

Reading, by the declared rule:

- The prediction "all three arms tie" missed on one contrast. The repaired
  cross-encoder beats base on real answers by 4.7 points. That is the first
  end-to-end evidence that the cross-encoder repair is worth shipping.
- Jev ties the cross-encoder on both metrics, and ties base on the primary
  metric. Ties break to parsimony, so the free local arm wins at k=5. Jev's
  R@1 lead from Lane 15 does not become more correct answers here.
- Flag: abstain rates run 62 to 73 percent. Pack memories are cut at about
  1200 chars, so most questions cannot be answered from five memories in any
  arm. Absolute rates are low for that reason; the lane measures the gap
  between arms, and that gap rides on the 46 questions where arms differed.
- Flag: one answering pass per item, one answering model (Sonnet, effort
  medium). Answer-model variance is unmeasured.
- Ledger: N = 17 lanes, 0.28 expected false passes at alpha 0.0167. The
  crossenc-vs-base pass is one pass beside that number.

### Lane 17: stopped at 32 of 76 shards, NO VERDICT

22 of 150 questions have all three arms. 192 of 450 items are missing.

| arm | depth | est. tokens | exact-answer rate | token-F1 | abstain rate |
|---|---|---|---|---|---|
| base | 40 | 12000 | 0.1818 | 0.2131 | 0.5909 |
| crossenc | 13 | 3900 | 0.1818 | 0.2443 | 0.5455 |
| jev | 2 | 600 | 0.2727 | 0.2694 | 0.5909 |

All three contrasts are tied at n=22 (jev vs base, exact: +0.0909
[0.0000, 0.2727]). The zero-width interval on crossenc vs base comes from both
arms getting the same 4 questions right; at n=22 that is a small-sample
artefact. This table is a diagnostic. It promotes nothing and demotes nothing.

### Process finding: the run cost 3x the quote and was stopped

- Quoted and approved: 96 agents, roughly 15M tokens.
- Measured at the stop: 65 agents started, 52 answer files landed, 13 agents
  killed in flight with their work lost. 46.9M tokens in total: 41.1M cache
  reads, 5.7M cache writes, 0.06M output. Mean 0.72M per agent.
- Root cause: the read plan gave each Read call up to 78 kB. The Read tool
  caps one call at 25,000 tokens and this text runs about 3 chars per token,
  so the planned call failed with "File content (26049 tokens) exceeds maximum
  allowed tokens (25000)". Agents fell back to 5 to 16 small reads, and every
  extra read re-sends the whole context.
- The chars-per-token ratio was assumed at 4 and never measured. No one-agent
  pilot ran before the fan-out.
- Rule from now on: one pilot agent on the largest shard, its tokens measured
  from the transcript, before any fan-out. Each planned Read stays at 60 kB or
  less.

### NOT-DONE after part 2

| item | state | why | what it needs |
|---|---|---|---|
| Lane 17, 44 remaining shards | not run | stopped for cost | a new yes on a measured per-agent cost |
| Stage 5 process null for Lane 15 | not run | label shuffle only so far | a declared replay design |
| Jev run-to-run variance | not run | each arm ran once | a second Jev pass, about $0.12 |

## AMENDMENT 6 (operational, written before the Lane 17 completion run, 2026-09-19)

Scope: the 192 Lane 17 items that have no answer yet. Nothing about the
questions, arms, depths, metrics, alpha or decision rule changes. Answers
already on disk stay as they are and are not re-asked.

- Re-cut: `results/wave3/scripts/wave3_reshard_v3.mjs` writes
  `results/wave3/blind-v3/` (50 shards, 5,657 kB, `manifest.json` beside
  them). Shards are 116 kB or less, no question repeats inside a shard, and
  each shard is read in at most two Read calls of 60 kB or less. The largest
  planned Read is 58,234 chars, about 19,500 tokens at the measured 2.99 chars
  per token, under the tool cap of 25,000.
- Brief: the answering instructions are the Amendment 5 text, word for word.
  Three things change: the input path, the Read plan, and one added sentence
  telling the agent to issue both Read calls in the same message. Answer files
  are named `lane17-answers-shard-rNN.json` so they cannot collide with the
  first run.
- Pilot gate: one Sonnet agent (effort medium) on the largest shard, `r44`.
  Its tokens are summed from its transcript. The other 49 agents launch only
  if the pilot cost 300,000 tokens or less. Its answers count like any other.
- Burn check: after the first 8 fan-out agents finish, tokens are summed
  again. A mean above 300,000 per agent stops the run. Stop rule on failures
  stays at 6.
- Cost quoted to Keith and approved ("B"): about 52 more agents, 12M to 16M
  tokens in total.
- Caution logged up front: the rerun shards are smaller than the first run's
  (116 kB against 144 kB), and the arms are split unevenly across the two
  runs because every jev@2 item sat in the first 30 shards. A run effect
  would be partly confounded with arm. Diagnostic to report: abstain rate and
  exact-answer rate per arm, first run against rerun.

### Amendment 6 pilot result (2026-09-19): gate NOT passed, by 3 percent

Run `wf_32a23fc4-08b`, shard `r44`, 8 items. The agent did what the brief
asked: two Reads in one message, one Write, 8 answers, valid JSON.

| turn | cache read | cache write | output |
|---|---|---|---|
| 1, both Reads issued | 0 | 71,365 | 300 |
| 2, Write | 71,365 | 45,470 | 1,649 |
| 3, final reply | 116,835 | 1,753 | 10 |

Total about 308,700 tokens against a gate of 300,000. The fan-out is held
until Keith says go. Projected total for all 50 shards: about 15.4M, inside
the quoted 12M to 16M.

What the turns show: 71,365 tokens of every turn are fixed overhead (system
prompt, tool list, instruction files), and the two Reads came to 45,470
tokens for 117.7 kB, so 2.59 chars per token once line-number prefixes are
counted. Cost per agent is close to 3 x overhead + 2 x file tokens. Regenerate
with `node results/wave3/scripts/wave3_progress.mjs wf_32a23fc4-08b`.

## Wave 3 results, part 3: Lane 17 complete (written 2026-09-19)

Regenerate every number here:
`node results/wave3/scripts/wave3_grade.mjs` (verdict table),
`node results/wave3/scripts/wave3_run_effect.mjs` (run effect and depth table),
`node results/wave3/scripts/wave3_progress.mjs wf_b9f83993-8a0` (burn).

### Completion run, burn against Amendment 6

49 agents plus the pilot. 50 of 50 answer files, 0 failures, 0 unreadable
files. Tool-call shape: 48 x Read,Read,Write and 1 x Read,Write (r50, one
planned read). Tokens from transcripts, deduped by message id: 15,001,344 for
the 49, mean 306,150 per agent. With the pilot, about 15.31M. The quote was 12M
to 16M. The workflow tool's own counter says 5,762,928; the transcript sum is
the larger number and the one reported here.

Deviation, logged: Amendment 6 said a mean above 300,000 per agent stops the
run. Completed agents ran at about 307,000, 2 percent over that line and level
with the pilot, which Keith had already waved through with the 15.4M projection
in front of him ("Just keep going dude"). The read plan held and the total sat
inside the quote, so the run was not stopped. It finished in 200 seconds,
before a stop could have saved anything. The defect was the line itself: it
was set below the pilot's own measured cost. A burn-check line belongs above
the pilot, as pilot cost plus a margin.

### Lane 17 verdict table (150 of 150 questions, 0 items missing)

| arm | exact-answer rate | token-F1 | abstain | est. tokens injected | memories |
|---|---|---|---|---|---|
| base@40 | 0.1533 | 0.1824 | 0.6400 | 12,000 | 40 |
| crossenc@13 | 0.1600 | 0.2064 | 0.6267 | 3,900 | 13 |
| jev@2 | 0.1400 | 0.1516 | 0.6333 | 600 | 2 |

| contrast | exact-answer rate | token-F1 |
|---|---|---|
| crossenc@13 vs base@40 | +0.0067 [-0.0200, 0.0333] tied | +0.0241 [-0.0072, 0.0582] tied |
| jev@2 vs base@40 | -0.0133 [-0.0533, 0.0200] tied | -0.0308 [-0.0703, 0.0052] tied |
| jev@2 vs crossenc@13 | -0.0200 [-0.0600, 0.0200] tied | -0.0549 [-0.1058, -0.0063] SIG against Jev |

Paired bootstrap, 2000 draws, question as unit, alpha 0.0167, seed 0xc0ffee.
Same answer in all three arms on 104 of 150. All three arms abstain on 81 of
150. At least one arm right on 27 of 150.

**Prediction: hit.** jev@2 ties base@40 on exact-answer rate at one twentieth
of the tokens. **By the rule declared before the run ("a tie on answers at a
fifth of the tokens is a win for Jev"), Lane 17 is a pass for Jev.** Ledger
line: N = 17, expected false passes at alpha 0.0167 = 0.28. That arithmetic
guards passes that clear an interval. This pass rests on a tie, and low power
hands out ties for free, so the flags below carry more weight than the ledger
line.

### Flags that ride this pass

1. **A tie is not "the same".** No equivalence margin was declared. The lower
   bound against base@40 is -0.0533 on a base rate of 0.1533, so jev@2 could
   be losing a third of the right answers and this test would still say tied.
   The verdict rides on the 27 questions where any arm was right.
2. **Jev loses the secondary metric.** Token-F1 against crossenc@13 is
   -0.0549 [-0.1058, -0.0063], significant, and it leans the same way against
   base@40. Two memories give thinner answers.
3. **The rule has a hole: the free arms never got a short pack.** The design
   compared Jev's 2 memories with the free arms' 13 and 40. It never asked
   whether the free arms also hold up at 2. The depth table below says depth
   buys nothing here for anyone, which makes that the live question.

### Depth table (UNDECLARED diagnostic, cannot move a verdict)

Same 150 questions, Lane 16 and Lane 17 cells side by side. The last two
columns count questions where exactly one of the pair was right.

| cell | exact-answer rate | est. tokens | only jev@2 right | only this cell right |
|---|---|---|---|---|
| jev@2 | 0.1400 | 600 | | |
| base@5 | 0.1067 | 1,500 | 6 | 1 |
| crossenc@5 | 0.1533 | 1,500 | 1 | 3 |
| jev@5 | 0.1467 | 1,500 | 4 | 5 |
| crossenc@13 | 0.1600 | 3,900 | 2 | 5 |
| base@40 | 0.1533 | 12,000 | 2 | 4 |

Reading: the exact-answer rate sits between 0.14 and 0.16 from 600 tokens to
12,000 for every cell except base@5. The free cross-encoder at k=5 already
matches base@40 at an eighth of the tokens and $0. So the saving that can be
credited to Jev on this evidence is 1,500 down to 600, and even that needs the
free arms tested at k=2. The ceiling near 0.15 comes from the packs (memories
cut near 1,200 chars, 81 of 150 questions unanswered by every arm), and ranking
cannot lift it.

### Run effect (the diagnostic Amendment 6 declared)

Anchor = Lane 16 exact-answer rate (mean of its three arms) on the same
questions. Lane 16 was answered in one run, so the anchor tracks question
difficulty only.

| arm | run | n | abstain | exact | anchor |
|---|---|---|---|---|---|
| base@40 | first | 64 | 0.5781 | 0.1875 | 0.1667 |
| base@40 | rerun | 86 | 0.6860 | 0.1279 | 0.1124 |
| crossenc@13 | first | 64 | 0.6406 | 0.1406 | 0.1510 |
| crossenc@13 | rerun | 86 | 0.6163 | 0.1744 | 0.1240 |
| jev@2 | first | 130 | 0.6385 | 0.1385 | 0.1333 |
| jev@2 | rerun | 20 | 0.6000 | 0.1500 | 0.1500 |

No run effect visible. Within each arm the first-run and rerun rates move with
the difficulty anchor, and the abstain rate has no common direction (up for
base, down for the other two). The largest gap from anchor is crossenc rerun,
+0.05 on n = 86, about 4 questions.

### NOT-DONE after Wave 3

| declared or owed | status | why | slot |
|---|---|---|---|
| Free arms at k=2 (base@2, crossenc@2), same 150 questions | not run | not in the Wave 3 declaration; found at the Lane 17 readout | proposed Lane 20: about 10 Sonnet agents, about 3M tokens, $0 cash; needs pre-registration and a yes |
| Equivalence margin for tie-based passes | not declared | Lane 17's rule accepted any tie | declare one inside Lane 20 before it runs |
| Stage 5 process null for Lane 15 | not run | unchanged from part 2 | none yet |
| Jev run-to-run variance | not run | about $0.12 of API calls, ASK-FIRST | none yet |
| Answer-model variance (one pass, one answering model) | not run | cost | none yet |

### Where the y/n stands after Wave 3

- Ship the cross-encoder repair: yes on the evidence (Lane 16, +0.0467
  [0.0133, 0.0867] on graded answers, $0 at run time).
- Jev as a reranker at equal depth: no (Lane 16, tied with the free arm).
- Jev as a token saver: passes its declared rule (Lane 17) with flag 3 open.
  If crossenc@2 also ties, the saving is free and the answer goes back to no.
- The release decision is Keith's and is still open.

## AMENDMENT 7: Lane 20, the free arms at 2 memories (pre-registered 2026-09-19, before any pack is built)

Approval: Keith, "Dude, keep going until completion", in reply to the quote
"about 10 Sonnet agents, about 3M tokens, $0 cash".

**Question.** Lane 17 credited a token saving to Jev: 2 memories answered as
well as base at 40. The free arms were never cut to 2. Does the saving belong
to Jev's ranking, or does any arm answer as well from 2 memories?

**Design.** Same 150 questions, same packs file (`results/wave3-packs.json`,
depth 40, char cap 1200), same brief word for word, same model (Sonnet, effort
medium), same blinding (`{item_id, question, memories}` only). Arms:

- base@2 and crossenc@2: newly answered in this lane.
- jev@2: answers REUSED from Lane 17, not re-answered. Declared here. Part 3's
  run-effect check found no difference between runs. If Jev wins this lane,
  the win carries the flag "jev@2 answered in an earlier run" and a same-run
  re-answer (about 5 agents) goes to the NOT-DONE table.

Shards use the blind-v3 recipe (116 kB a shard, two parallel Reads of 60 kB or
less, no question twice in one shard). Files `blind-v3/lane20-tNN.json`,
answers `lane20-answers-shard-tNN.json`, key `results/wave3-answerkey-lane20.json`.

**Metrics.** Primary: exact-answer rate. Secondary: token-F1. Paired
bootstrap, 2000 draws, question as unit, seed 0xc0ffee, alpha 0.0167 across
three contrasts. A question missing any arm is dropped from all three.

**Equivalence margin, declared: 0.05 absolute on exact-answer rate.** Two arms
are "equivalent" only when the whole interval sits inside (-0.05, +0.05).

**Decision rule.** The deciding contrast is jev@2 against crossenc@2, because
the repaired cross-encoder ships in both release options.

- Jev wins (interval lower bound above 0): the token saving belongs to Jev.
  Lane 17's pass stands and its flag 3 closes. The opt-in option has a
  measured case.
- Equivalent, or crossenc@2 ahead: the saving is free. Lane 17's pass is
  demoted to "a property of these packs". Jev: no.
- Neither (interval crosses zero and is wider than the margin): not shown.
  Wave 3 rule applies: ties break to parsimony and a null closes the
  question. Jev: no for shipping, power statement printed beside it.
- base@2 is the liveness control. The depth curves rank base worst. If base@2
  is equivalent to both other arms, the harness cannot see ranking at this
  depth, and that is reported as the finding.

**Power, stated up front.** Lane 17 intervals had a half-width near 0.04 on
these 150 questions, and any arm was right on only 27. The smallest win this
lane can detect is about 0.04 to 0.05, which is 6 to 8 questions. Equivalence
at 0.05 needs a point difference within about 0.01.

**Prediction.** jev@2 minus crossenc@2 lands within 0.02 of zero with an
interval that crosses zero: "not shown", Jev no. jev@2 minus base@2 lands
between +0.04 and +0.06, so the control arm is alive.

**Ledger.** N = 18. Expected false passes at alpha 0.0167: 0.30.

**Cost guard.** Quote: about 10 agents, about 3M tokens. Pilot first: one
agent on the largest shard, tokens summed from its transcript, deduped by
message id. Go if the pilot is 385,000 or less (1.25 x the 308,000 measured on
this recipe). Stop and report if the projected total passes 4M or the
tool-call shape breaks from the planned parallel Reads then one Write. A shard
that fails or writes unreadable JSON is rerun once with the same brief.

**This verdict is only as good as this rule. Attack the rule, not just the
numbers.** The soft spot: exact match on one gold string, one answering model,
one pass, and a benchmark where 81 of 150 questions got no answer from any arm
in Lane 17.

## Wave 3 results, part 4: Lane 20, the free arms at 2 memories (written 2026-09-19)

Regenerate every number below:

```
node results/wave3/scripts/wave3_lane20_build.mjs      # packs, key, shards, input-side checks
node results/wave3/scripts/wave3_grade.mjs             # verdict tables, Lanes 16, 17 and 20
node results/wave3/scripts/wave3_lane20_diag.mjs       # discordant pairs, cross-depth contrasts
node results/wave3/scripts/wave3_progress.mjs wf_f0cf019f-d58   # pilot burn
node results/wave3/scripts/wave3_progress.mjs wf_2faf39cc-2ce   # the other 7 agents
```

The grader was extended to read `results/wave3-answerkey-lane20.json` and to
print an `inside_margin` field. Lane 16 and Lane 17 numbers printed the same
before and after that change.

### Burn against Amendment 7

| | quote | measured |
|---|---|---|
| agents | about 10 | 8 |
| tokens | about 3M | 2,510,392 (pilot 319,073 + 2,191,319) |
| pilot gate | 385,000 or less | 319,073, shape Read,Read,Write: go |
| answer files | 8 | 8 of 8, 0 unreadable, 0 items missing |

One agent wrote its answer file twice and cost 438,449. The total stayed
inside the quote, so the run was not stopped.

### Lane 20 verdict table (150 of 150 questions, every arm at 2 memories, about 600 tokens)

| arm | exact-answer rate | token-F1 | abstain rate |
|---|---|---|---|
| base@2 | 0.0867 | 0.1021 | 0.8067 |
| crossenc@2 | 0.1067 | 0.1419 | 0.6933 |
| jev@2 (Lane 17 answers, reused as declared) | 0.1400 | 0.1516 | 0.6333 |

| contrast | exact-answer rate | token-F1 | discordant questions |
|---|---|---|---|
| jev@2 - crossenc@2 (deciding) | +0.0333 [-0.0067, 0.0800] tied, NOT inside the 0.05 margin | +0.0097 [-0.0320, 0.0552] tied | 6 to 1 |
| jev@2 - base@2 | +0.0533 [0.0200, 0.1000] SIG | +0.0495 [0.0078, 0.0991] SIG | 8 to 0 |
| crossenc@2 - base@2 | +0.0200 [-0.0200, 0.0600] tied | +0.0398 [-0.0016, 0.0791] tied | 5 to 2 |

Identical answers across all three arms: 99 of 150. All three abstain on 84 of
150. At least one arm right on 22 of 150.

### Verdict by the declared rule

- **Deciding contrast: "neither".** The interval crosses zero and is wider
  than the margin. Not shown. Ties break to parsimony. **Jev: no for shipping.**
- **Power statement.** The lane could detect a win of about 0.04 to 0.05. The
  observed lead is +0.0333, which is 5 questions net, 6 against 1. The lower
  bound misses zero by one question. An exact sign test on 6 against 1 gives
  p = 0.125. This is the closest Jev has come to a win on graded answers, and
  it is still inside the noise bar.
- **Liveness control: alive.** base@2 is not equivalent to both other arms.
  Jev beats it with a clean interval, so the harness can see ranking at this
  depth.
- **Lane 17's pass.** The rule demotes it only if the free arms are
  equivalent or ahead at 2. They are not. The rule closes its flag 3 only if
  Jev wins at 2. It did not. So the pass stands as declared and flag 3 is
  answered but not closed: the free arms do lose answers at 2 (diagnostic
  below), and Jev's lead over them at 2 is not shown.
- **Flag on the one significant contrast.** jev@2 over base@2 compares answers
  from two runs: jev@2 was answered in the Lane 17 runs, base@2 in this one.
  Part 3's run-effect check found no run difference, and that check had low
  power.

### Prediction check

- jev@2 minus crossenc@2 "within 0.02 of zero, interval crossing zero": the
  interval part hit, the size missed. The point estimate is +0.0333. Jev did
  better than predicted.
- jev@2 minus base@2 "between +0.04 and +0.06": hit, +0.0533.

### Cross-depth contrasts (UNDECLARED diagnostic, cannot move a verdict)

Same 150 questions. The two sides of each row were answered in different runs.

| contrast | exact-answer rate |
|---|---|
| crossenc@2 - crossenc@5 | -0.0467 [-0.0933, -0.0133] SIG |
| crossenc@2 - crossenc@13 | -0.0533 [-0.1067, -0.0067] SIG |
| base@2 - base@5 | -0.0200 [-0.0533, 0.0000] tied |
| base@2 - base@40 | -0.0667 [-0.1133, -0.0200] SIG |
| jev@2 - jev@5 | -0.0067 [-0.0533, 0.0400] tied |
| jev@2 - crossenc@5 | -0.0133 [-0.0467, 0.0133] tied |

Reading: the free arms lose answers when cut from 5 or more memories to 2.
Jev does not. So Jev's ordering is what lets a 2-memory pack work. The
practical comparison for a release is the last row: Jev at 600 tokens against
the free cross-encoder at 1,500 tokens, tied. What Jev buys on this evidence
is about 900 tokens a query, for 295 ms, about $0.0004 and a credential on
the read path. It buys no answers.

By question type (exact answers out of 25, base / crossenc / jev):
knowledge-update 5 / 5 / 7, multi-session 1 / 2 / 3, single-session-assistant
4 / 3 / 4, single-session-preference 0 / 0 / 0, single-session-user 2 / 3 / 4,
temporal-reasoning 1 / 3 / 3.

### Self-audit at campaign close (Stage 5.6)

1. **Data.** One external corpus for every graded-answer lane. Packs cut
   memories at 1200 chars, which drives abstain rates of 63 to 81 percent, so
   each verdict rides on 22 to 46 questions out of 150.
   single-session-preference scored 0 for every arm in Lane 20: exact match on
   one gold string cannot grade that type, so the real n is nearer 125.
2. **Statistics.** Three graded lanes share the same 150 questions and the
   same jev@2 answers, so they are not independent trials. The ledger's 0.30
   expected false passes over-counts for that reason and no pass rests on it
   anyway. Lane 17's rule had no margin; Lane 20 fixed that. Cross-lane rows
   mix runs and stay diagnostics.
3. **Code.** Deterministic grader, no LLM judge. The Lane 20 change was
   checked by reprinting Lanes 16 and 17 unchanged. `wave3_lane20_diag.mjs`
   asserts its deltas equal the grader's and that the reused jev@2 answers
   are the Lane 17 ones on all 150 questions.
4. **Process.** Two cost overruns early in Wave 3, then pilot-first held
   twice (15.3M against 12M to 16M, 2.5M against 3M). One answering model, one
   pass per cell. Lane 20 is the third graded test of one construct (Jev
   ordering into graded answers on these 150 questions) and the third result
   inside the noise bar. Pinned rule: a number inside the noise bar does not
   justify another run of the same kind. **The campaign stops here.** A
   further test needs a new input: a bigger question set (about 450 questions
   to halve the interval) or a second corpus, pre-registered, with Jev API
   spend approved first.

### NOT-DONE at campaign close

| declared or owed | status | why | slot |
|---|---|---|---|
| Same-run re-answer of jev@2 (about 5 agents) | not run | owed only if Jev won the deciding contrast; it did not | none |
| Larger question set or second corpus for the 2-memory question | not run | new input, needs Jev API spend (ASK-FIRST) and a fresh declaration | none; Keith's call |
| Stage 5 process null for Lane 15 | not run | unchanged | none |
| Jev run-to-run variance | not run | about $0.12 of API calls, ASK-FIRST | none |
| Answer-model variance | not run | cost | none |
| Cross-encoder cut-threshold sweep | not run | free, never touched | next hippo retrieval work |

### Final y/n for the campaign

- **Does Jev rank better than hippo's free reranker? Yes.** R@1 +0.2033
  [0.1333, 0.2733] on Keith's store and +0.0700 [0.0200, 0.1200] on
  LongMemEval, stable across 20 seeds.
- **Does that turn into better answers? Not shown, three times.** Lane 16 at 5
  memories: -0.0067 [-0.0533, 0.0400]. Lane 17 at 2 against 13 and 40: tied.
  Lane 20 at 2 against 2: +0.0333 [-0.0067, 0.0800].
- **Does the free cross-encoder repair help answers? Yes at 5 memories.**
  +0.0467 [0.0133, 0.0867] over base (Lane 16).
- **Ship Jev? No, on this evidence.** Ship the cross-encoder repair. Jev stays
  measured and unshipped. The release decision is Keith's and is still open.

# DECISION RECORD (2026-09-19, after Wave 3 part 4)

Keith chose Option 2: ship the cross-encoder repair AND Jev as an opt-in
reranker. That is against the author's pick (fix only), and it is his call:
the gate rule says promotion needs his sign-off, and he gave it for the opt-in
form. The decision changes no evidence. Ranking win shown on two corpora.
Answer win over the free cross-encoder not shown in three graded lanes. The
measured benefit is about 900 context tokens a query. Lines above that say the
decision "is still open" were true when written and stay as written.

What ships: `--reranker jev`, off by default, behind `TYPESAFE_API_KEY`. The
shipped request shape is the measured one: `scripts/rerank-3arm-ab.mjs` calls
`jevReranker` from `src/rerankers/jev.ts` directly, pool 40. Two changes from
the measured code, neither touching the request or the scoring. First, a
missing key or any failed call now warns once and falls back to the local
cross-encoder; the campaign code threw on a missing key and swallowed every
other failure into an unranked order. Second, the default timeout drops from
30 s to 5 s. The release notes and `docs/evals/2026-09-19-jev-reranker.md`
carry the not-shown answer result next to the ranking win.

# CORRECTION 2: `src/judgment.ts` does not ship

The "Standing" bullet near the top of this file says `src/judgment.ts` ships
behind `TYPESAFE_API_KEY`. It does not. `src/judgment.ts` and
`tests/judgment.test.ts` are untracked campaign files with no call site in
`src/`, and they are not part of the release.

# LANE 21 PRE-REGISTRATION: can recall say "nothing here answers this"? Declared 2026-09-19, BEFORE the run

Keith's "Go" on 2026-09-19 approves about $0.12 of Jev API spend for this lane.
This is a new question (abstention) and a new mechanism (a presence `noul`). It
is not a fourth graded-answer run on the 150 LongMemEval questions, so the
campaign-close rule does not block it. It also runs the owed "cross-encoder
cut-threshold sweep" from the NOT-DONE table, which is free.

## Decision it gates

Whether `hippo recall` should get an opt-in "return nothing when nothing
answers" cut, and whether that cut should read a Jev score or a free local one.

## Population and label

The 300 paraphrase queries (`evals/paraphrase/queries1-4.json`), same search
options, clock and pool as Lane 15: top 40 candidates, 1,200 chars each.
Label `answerable` = the target memory is inside the top-40 pool. Cached Lane 15
rows give 224 answerable, 76 not (`results/rerank-3arm-2026-09-18.json`,
`preRerankRank > 40`). The label is recomputed at run time because the live
store has grown since; the run reports the new split.

Caution flag, declared now: "target outside the pool" is not the same as "no
candidate answers". A near-duplicate memory can answer. The run dumps the 15
not-answerable queries with the highest presence score for a hand look. That
look is a diagnostic and cannot flip the verdict.

## Sample-size math

Hanley-McNeil at AUC 0.80 with 224 and 76: SE about 0.026 on all 300. A paired
delta under about 0.05 is noise. On a half (about 112 and 38) SE is about 0.037,
and one wrong abstain is about 0.9 points.

## Arms, all scored per query on the same pool

| Arm | Signal | Cost |
|---|---|---|
| F1 | hippo's own top base score | free, what exists today |
| F2 | max repaired cross-encoder score over the 40 | free |
| J1 | max per-candidate Jev `noul` over the 40 (the shipped request's own output) | paid |
| J2 | one extra `noul` named `present` in the SAME request | paid, same call |

One request per query carries c1..c40 plus `present`, so 300 calls, about $0.12.
Hard cap: 320 calls or $0.20, whichever comes first. Pilot 5 calls first, lint
the body before the first call, stop on any 422. Model pinned to `jev-1.13.0`
because a threshold gets tuned.

The `present` question is frozen here and is never reworded inside this lane:

- question: "Does at least one numbered candidate memory contain the specific
  information needed to answer the query?"
- context: "The candidates were fetched by a keyword and embedding search, so
  they often share words or a topic with the query without answering it."
- focus: "Judge whether the answer itself is present in a candidate, not
  whether a candidate is on the same topic or uses the same terms."
- criteria true: what "At least one candidate states the fact, rule, fix or
  decision the query asks for." not_for "Candidates that only mention the same
  tool, file, project or error name without giving what the query asks for."
- criteria false: what "No candidate gives what the query asks for, even if
  several are on a related topic." not_for "Cases where one candidate answers
  the query in different words from the query."
- one invented example per side, neither taken from the 300 queries.

## Metrics

1. Ranking metric, all 300: AUC of each arm against `answerable`, ties count
   half. Paired bootstrap over queries, 2,000 draws, seed 21.
2. Operating point: abstain when score < t. Dev half = queries1 + queries2,
   judge half = queries3 + queries4. Pick t on dev as the largest cut with
   wrong-abstain at or under 2% of dev answerable. Report on judge: caught
   (share of not-answerable cut) and wrong-abstain (share of answerable cut).
   For Jev arms also report how many judge cases sit within 0.06 of t, the
   measured repeat noise.
3. Integrity: Jev R@1 from this run beside Lane 15's, to prove the extra
   question did not move the c-scores. A dead or flat arm voids the run.
4. Null: 1,000 label permutations of the AUC delta, p95 reported.

## Decision rule

Two verdict contrasts, alpha 0.025 each, 97.5% intervals: 21a = J2 minus the
best free arm, 21b = J1 minus the best free arm.

- **JEV PASS:** a Jev arm beats the best free arm on AUC with the interval
  excluding zero, AND on the judge half it holds wrong-abstain at or under 5%
  with caught at or over 50%. Promotion still needs Keith's sign-off.
- **FREE WIN:** a free arm meets the judge-half bar and no Jev arm beats it on
  AUC. Then the free cut is the proposal and Jev presence is closed.
- **FAIL:** no arm meets the judge-half bar. Nothing ships; abstention stays
  the caller's job.
- A tie goes to the free arm. If either half holds under 25 not-answerable
  queries the operating point is reported as underpowered; no re-split.

Precedent that binds: ROADMAP C1. Any cut that ships is read-side, opt-in, off
by default, and never blocks a write.

## Trial ledger

Two new verdict contrasts on a query set already used by Lanes 9a, 12, 13, 15
and 19. N rises by 2 from the Lane 20 ledger line. The presence question was
never tuned on this set; the threshold is tuned on the dev half only.

---

# LANE 21 RESULT: FAIL at the declared cut. The presence score carries real signal; this test bed cannot price it. 2026-09-19

Run: `scripts/jev-presence-eval.mjs`, model pinned `jev-1.13.0`. Output: `results/lane21-presence-2026-09-19.json`,
`results/lane21-handlook.json`, raw replies in `results/lane21-cache/` (299 files).
Regenerate every number below with no spend: `node scripts/jev-presence-eval.mjs` (all 299 replies are cached).

## Verdict

**FAIL.** No arm meets the judge-half bar (wrong-abstain at or under 5% AND caught at or over 50%).
Nothing ships. No abstain cut is proposed, paid or free.

## Population and spend

- 303 queries merged, 4 targets no longer in the store, 299 usable. Label: 218 answerable, 81 not.
- Dev half holds 40 not-answerable, judge half 41. Both are over the 25 floor.
- Calls: 5 pilot + 294 full = 299, under the 320 cap. All ok, 0 failed, 0 HTTP 422. 2,223,237 input tokens, about $0.09.

## AUC, all 299, ties count half

| Arm | AUC |
|---|---|
| F1 hippo top base score (free) | 0.6226 |
| F2 max cross-encoder score (free) | 0.7359 |
| J1 max per-candidate Jev noul (paid) | 0.8550 |
| J2 Jev `present` noul (paid) | 0.8712 |

Best free arm: F2.

| Contrast | delta | 97.5% interval |
|---|---|---|
| 21a J2 minus F2 | +0.1352 | [0.0536, 0.2144] |
| 21b J1 minus F2 | +0.1191 | [0.0392, 0.2029] |

Null: 1,000 label permutations of max(J1,J2) minus max(F1,F2), p95 = 0.0520. Both deltas sit above it and
above the 0.05 noise bar declared from the sample-size math.

## Operating point, judge half (t picked on dev at wrong-abstain at or under 2%)

| Arm | t | caught | wrong abstain | judge cases within 0.06 of t |
|---|---|---|---|---|
| F1 | 0.3648 | 1/41 (2.4%) | 1/108 (0.9%) | n/a |
| F2 | 0.0006 | 6/41 (14.6%) | 2/108 (1.9%) | n/a |
| J1 | 0.69 | 13/41 (31.7%) | 2/108 (1.9%) | 17 |
| J2 | 0.56 | 13/41 (31.7%) | 2/108 (1.9%) | 13 |

The Jev arms catch about twice what the cross-encoder catches at the same wrong-abstain rate, and still stop
at one in three. The bar was one in two.

## Integrity

- Jev R@1 this run 0.5886, Lane 15 0.6167. A 2.8 point gap, with a grown store (2,001 entries), the pinned
  model in place of `jev-latest`, and one extra question in the request. No arm is flat: J1 has 46 distinct
  values, J2 64, F1 and F2 299 each.
- Independent check by the main thread from the saved rows: the AUC table (by pair counting) and the
  operating-point table both reproduce to the last digit.
- `git -C hippo status --porcelain` shows 0 tracked changes. `src/rerankers/jev.ts` was not touched.

## Diagnostics (undeclared, cannot move the verdict)

1. Looser dev caps, judge half. At a 5% dev cap J2 catches 20/41 (48.8%) at 5/108 wrong (4.6%); J1 19/41 at
   8/108 (7.4%); F2 10/41 at 4/108 (3.7%). At a 10% cap J2 catches 23/41 (56.1%) at 9/108 (8.3%). So the
   declared rule's own tension (cut picked at 2%, bar allows 5%) does not decide the verdict: at 5% J2 sits one
   query short of the bar, inside the noise of 41 cases (SE about 7.8 points).
2. J2 by label: answerable median 0.92, 78.0% at or over 0.85. Not-answerable median 0.66, 24.7% at or over
   0.85, 28.4% under 0.5.
3. Hand look at the 15 not-answerable queries with the highest J2, reading the first 190 characters of the top
   3 candidates each: at least 9 of the 15 look answered by a different memory than the target (build-log
   rule, iOS signing fix, consolidation result, soft-permission rule, btlab cost verdicts, stale-data lesson,
   grant table, signal-freeze fix, Git Bash PATH). About 4 more look partly answered. In those rows Jev said
   "present", the label said "not answerable", and Jev looks right.

## What the hand look means

The caution flag declared before the run turned out to be the main finding. Every query in this set was
written from a memory in the store. A query lands in the not-answerable group only through a retrieval miss,
and the store holds near-duplicates that fill the gap. So the label is contaminated exactly where J2 scores
high. That pushes J2's measured caught rate down and leaves the true rate unknown. This set can show that the
presence score separates the groups (it does). It cannot price an abstain cut.

## Stage 5.6 self-audit

Data
1. Label noise as above. The not-answerable group mixes true no-answer cases with near-duplicate hits, in
   unknown proportion. Only 15 of 81 were looked at, from previews.
2. Store drift: 299 of 303 usable, split 218 and 81 against the cached 224 and 76.

Statistics
3. The declared rule picked the cut at 2% and judged against a 5% bar. Diagnostic 1 shows the verdict does
   not turn on that; the 5% read is a coin flip on one query.
4. 13 of 149 judge cases sit inside Jev's 0.06 repeat-noise band around t for J2 (17 for J1). About 9% of
   abstain decisions could flip on a re-ask. No repeat-noise run was made.
5. J1 has 46 distinct values, so its AUC leans on the tie rule more than the free arms do.

Code
6. The script was written by a Sonnet agent and not line-reviewed. Cover: both verdict tables were recomputed
   from the saved rows by separate code and match. The bootstrap and null code were read (paired draws, seed
   21, 2,000 draws; null seed 2021) and not re-run.

Process
7. The brief to the agent quoted Lane 15's Jev R@1 as 0.4667. The file says 0.6167. That number was written
   from recall, not from the file. The agent caught it and used the file. Sourcing slip by the author.
8. Author declared, agent ran, author judged. No independent critique: Stage 5.7 gates a PASS surface and
   there is none.
9. The pilot peek (0.87 on a not-answerable query) changed nothing in the design.

## NOT-DONE

| Item | Status | Why |
|---|---|---|
| Clean no-answer population (queries about things the store never held) | not run | needs new queries and about $0.04; ask-first; the only input that can settle the question |
| Repeat-noise run on `present` | not run | paid; only matters if a cut is ever proposed |
| Full hand label of all 81 not-answerable rows | not run | 15 looked at, from previews |
| Combined free plus Jev score | not declared, not run | would be a new lane |
| Cross-encoder cut-threshold sweep (open since campaign close) | covered by arm F2 | weak: AUC 0.7359, 14.6% caught at the declared cut |

## Trial ledger

N = 20 (18 at the last stated ledger line, plus 21a and 21b). Expected false passes: 18 x 0.0167 + 2 x 0.025
= 0.35. Both contrasts cleared their intervals on AUC, and AUC alone was never the verdict. They share one
query set with Lanes 9a, 12, 13, 15 and 19, so they are not independent trials.

## Standing

Jev presence is closed as an abstain cut on this evidence. It stays on record as the first hippo lane where a
Jev score beat the best free score on something other than ranking. The pinned rule applies: another run on
this query set is a run of the same kind and is not justified. Reopening needs a new input (the clean
no-answer set) and Keith's yes on the spend.

---

# LANE 22 PRE-REGISTRATION (ROADMAP CLF4): does free CLEF rank like the paid reranker? Declared 2026-10-04, before any scored call

## Why this is a new input, not a rerun

Lanes 15 and 21 closed what Jev can do on this query set. CLEF (`@cf/cloudflare/clef-flash`, shipped as
`--reranker clef-flash` in 1.59.0) is a different model reached through a different transport, and it costs
nothing inside the Workers AI free allocation. The question is new: does a free model reproduce the ranking
win that only a paid model has shown here. One shape check ran before this was written: one sizing call on
one query (5,962 input tokens, 40 of 40 answers, 39 distinct scores). It decided the split below and was
not scored.

## Design

- `scripts/rerank-3arm-ab.mjs` with `RERANK_ARM=clef-flash`: arms base, repaired cross-encoder and
  clef-flash on one shared candidate set per query, depth 40, NOW pinned to `2026-09-18T14:31:52.073Z`.
- Corpus: a frozen copy of `~/.hippo` taken 2026-10-04T07:25Z (`VACUUM INTO` plus `embeddings.json` and
  `config.json`), 6,826 entries, passed as `RERANK_HIPPO_ROOT`. The live store is never read.
- Queries: the 303 paraphrase queries, 283 usable on this corpus (20 targets gone).
- Spend: 0 USD. clef-flash costs 8,182 neurons per million input tokens and the free allocation is 10,000
  neurons a day. The 283 requests measure 8.4M characters, about 1.67M tokens or 13,700 neurons, so the run
  is split over two UTC days: `RERANK_MAX_CALLS=142` on day 1, the rest on day 2, answers cached per query in
  `RERANK_CACHE_DIR`. A fallback is never cached. No verdict prints until all 283 are scored.
- Transport: Workers AI with the wrangler OAuth login, which carries `ai:write`.

## Metrics and decision rule

Paired bootstrap over queries, 2,000 draws, seed 4242, one contrast for the verdict at alpha 0.0125
(98.75% interval), as in Lane 15.

- **Primary, the verdict:** clef-flash minus cross-encoder on R@1.
  - CLEF RANKS: the interval excludes zero upward.
  - CROSS-ENCODER RANKS: the interval excludes zero downward.
  - TIE: the interval holds zero; a tie goes to the local model.
- **Declared secondaries, reported, never the verdict:** clef-flash minus cross-encoder on recall@budget
  (the product metric, Lane 15) and on memories needed to reach a 60% hit rate (the Amendment 4 depth
  read, computed from the saved ranks).
- **Void:** any query that falls back, or a degenerate arm, voids the run (the script's own checks).
- Jev is not re-run (paid). Lane 15's +0.2033 and Lane 21's Jev R@1 0.5886 were measured on stores of under
  2,100 entries, so they are context only and cannot enter a contrast.

## Predictions, declared now

1. clef-flash beats the cross-encoder on R@1, with a point delta between +0.10 and +0.25.
2. recall@budget ties (interval holds zero), as it did for Jev.

## What a verdict does and does not do

No default changes on this lane. CLEF RANKS earns a task-level lane (does the answer reach the model), the
ROADMAP's adoption bar; TIE or CROSS-ENCODER RANKS closes clef-flash as a ranking upgrade on this store.

## Trial ledger

One new verdict contrast on a query set already used by Lanes 9a, 12, 13, 15, 19 and 21. N = 21. Not
independent of those lanes.

## Run log

- Day 1, 2026-10-04: 142 calls, 846,604 input tokens (about 6,930 neurons), 142 answers cached, 0 fallbacks
  cached. The cross-encoder arm did not load in that run: the fresh worktree lacked the optional
  `@xenova/transformers`, and the warm-up guard watched `console.warn` while the logger writes to stderr, so
  it missed the fallback. The CLEF answers do not depend on that arm. Fixed before any verdict: version
  2.17.2 installed (the one earlier lanes used), and the guard now checks the scores the warm-up returns.
  Checked both ways: with the package hidden the run stops; with it present a zero-call run loads the model
  in 2.5 s and resumes 142 cached answers.
