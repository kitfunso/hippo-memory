# Eval index

Every measurement hippo publishes, and the document that produced it. Pre-registrations
are kept next to their results so you can check what was promised before the numbers
existed. Protocol for writing a new one: [AUTHORING.md](AUTHORING.md).

Grep this file for a metric or a feature name to find the doc that owns it.

## The numbers we quote publicly

These four are the claims that appear in the README, on hippo-memory.com, or in release
notes. Each links to the document that holds the method, the intervals and the limits.

| Claim | Number | Source |
|---|---|---|
| LongMemEval-S retrieval, per-question haystack, R@5 | 98.6% zero-dep default, 99.8% voyage-3-large | [2026-06-09-longmemeval-per-haystack-dual.md](2026-06-09-longmemeval-per-haystack-dual.md) |
| LongMemEval-S, one unified store of 19,195 sessions, R@5 | 47.2% default, 56.4% voyage-3-large | [2026-06-09-longmemeval-per-haystack-dual.md](2026-06-09-longmemeval-per-haystack-dual.md) |
| Jev reranker, R@1 on a 300-query developer store | 0.2600 base, 0.4133 cross-encoder, 0.6167 Jev | [2026-09-19-jev-reranker.md](2026-09-19-jev-reranker.md) |
| LoCoMo evidence R@5, overall, n=1,982 | 0.363 | [../../benchmarks/LOCOMO_INVESTIGATION.md](../../benchmarks/LOCOMO_INVESTIGATION.md) |

**Read the Jev doc before quoting it.** The ranking win is real and replicated on two
corpora. The answer-rate win was **not** shown: three graded tests all tied against the
free local cross-encoder, and those three share one 150-question set. The defensible
claim is a shorter context, not a better answer.

## By campaign, newest first

### Reranking (2026-09)

| Doc | What it settles |
|---|---|
| [2026-09-19-jev-reranker.md](2026-09-19-jev-reranker.md) | Jev reranker: what was measured, what it costs, what it does not do |

### Learned components, LC2 (2026-08)

| Doc | Title |
|---|---|
| [2026-08-09-lc2-memory-value-prereg.md](2026-08-09-lc2-memory-value-prereg.md) | Pre-registration: LC2 memory-value eval protocol + E2 acceptance bars |
| [2026-08-09-lc2-memory-value-result.md](2026-08-09-lc2-memory-value-result.md) | LC2-E1 baseline results: memory-value retention on LongMemEval-S (cleaned) |
| [2026-08-10-lc2-e2-fit-prereg.md](2026-08-10-lc2-e2-fit-prereg.md) | LC2-E2 pre-registration: linear memory-value fitter |
| [2026-08-10-lc2-e2-fit-result.md](2026-08-10-lc2-e2-fit-result.md) | LC2-E2 result: learned linear memory-value weights BEAT recency on held-out |
| [2026-08-10-lc2-e3-wiring-prereg.md](2026-08-10-lc2-e3-wiring-prereg.md) | LC2-E3 Wiring, pre-registered gates (LOCKED) |
| [2026-08-10-lc2-e3-wiring-result.md](2026-08-10-lc2-e3-wiring-result.md) | LC2-E3 Wiring, result (ALL GATES GREEN) |

### Retrieval and embeddings (2026-06 to 2026-07)

| Doc | Title |
|---|---|
| [2026-07-18-global-row-embeddings-result.md](2026-07-18-global-row-embeddings-result.md) | Global-row embeddings (v1.27.0), result |
| [2026-07-18-s5-path-overlap-result.md](2026-07-18-s5-path-overlap-result.md) | S5 path-overlap tuning, measurement and decision record |
| [2026-06-09-longmemeval-per-haystack-dual.md](2026-06-09-longmemeval-per-haystack-dual.md) | LongMemEval-S retrieval: per-haystack dual-embedder measurement + global-pool correction |
| [2026-06-09-lifecycle-stress-eval-prereg.md](2026-06-09-lifecycle-stress-eval-prereg.md) | Lifecycle Stress Eval (first slice), pre-registration |
| [2026-06-09-lifecycle-stress-eval-result.md](2026-06-09-lifecycle-stress-eval-result.md) | Lifecycle Stress Eval (first slice), result |
| [2026-06-10-dag-consolidation-slice1-result.md](2026-06-10-dag-consolidation-slice1-result.md) | DAG consolidation hierarchy, first slice (MEASURED-FALSE) |

### Graph and cross-object recall (2026-06)

| Doc | Title |
|---|---|
| [2026-06-02-l1-graph-stream-prereg.md](2026-06-02-l1-graph-stream-prereg.md) | L1 graph-retrieval stream, pre-registration |
| [2026-06-02-l1-graph-stream-result.md](2026-06-02-l1-graph-stream-result.md) | L1 graph-retrieval stream, result |
| [2026-06-02-e3-cross-object-precision.md](2026-06-02-e3-cross-object-precision.md) | E3.1 cross-object `references` precision (DESCRIPTIVE) |
| [2026-06-02-e3.2-multihop-result.md](2026-06-02-e3.2-multihop-result.md) | E3.2 multi-hop graph recall (DESCRIPTIVE) |
| [2026-06-02-e3-sleep-enqueue-hook-result.md](2026-06-02-e3-sleep-enqueue-hook-result.md) | E3 sleep enqueue-hook (DESCRIPTIVE) |
| [2026-06-02-graph-observability-result.md](2026-06-02-graph-observability-result.md) | Graph observability and visualization |

### The R@5 campaign, tracks 1 to 9 (2026-05)

Nine tracks chasing one LongMemEval R@5 target. Each track has a pre-registration and a
result; read them as a pair.

| Track | Prereg | Result |
|---|---|---|
| 1, hybrid tuning | [prereg](2026-05-11-r5-track1-tuning-prereg.md) | [result](2026-05-11-r5-track1-tuning-result.md) |
| 2, cross-encoder and sub-agent rerank | [prereg](2026-05-11-r5-track2-cross-encoder-prereg.md) | [result](2026-05-11-r5-track2-cross-encoder-result.md) |
| 3, F10 richer ingest | [prereg](2026-05-11-r5-track3-richer-ingest-prereg.md) | [result](2026-05-11-r5-track3-richer-ingest-result.md) |
| 4, F11 embedding upgrade | [prereg](2026-05-11-r5-track4-embedding-upgrade-prereg.md) | [result](2026-05-11-r5-track4-embedding-upgrade-result.md) |
| 5, F12 e5-large + top-100 | [prereg](2026-05-11-r5-track5-e5-large-top100-prereg.md) | [result](2026-05-11-r5-track5-e5-large-top100-result.md) |
| 6, F13 chunk per turn | [prereg](2026-05-12-r5-track6-chunk-per-turn-prereg.md) | [result](2026-05-12-r5-track6-chunk-per-turn-result.md) |
| 7, F14 F13 pipeline on the `_s` split | [prereg](2026-05-12-r5-track7-s-split-prereg.md) | [result](2026-05-12-r5-track7-s-split-result.md) |
| 8, F15 sub-agent rerank on F14 top-100 | [prereg](2026-05-12-r5-track8-subagent-rerank-prereg.md) | [result](2026-05-12-r5-track8-subagent-rerank-result.md) |
| 9, F16 multilingual-e5-large chunked turn | [prereg](2026-05-14-r5-track9-f16-e5-large-chunked-prereg.md) | [result](2026-05-14-r5-track9-f16-e5-large-chunked-result.md) |
| F9, hybrid RRF parity | [prereg](2026-05-20-f9-hybrid-rrf-prereg.md) | [result](2026-05-20-f9-hybrid-rrf-result.md), [dry run](2026-05-20-f9-dry-run.md) |
| F6, reranker hardening | [prereg](2026-05-10-f6-reranker-prereg.md) | [result](2026-05-10-f6-reranker-result.md) |

### Goal stack, calibration and the v1.7 to v1.9 retractions (2026-05)

This run is kept in full because it includes a retraction. A claim was published, then
measured properly, then withdrawn. The inventories are the audit trail.

| Doc | Title |
|---|---|
| [2026-05-07-v1.7.5-claim-inventory.md](2026-05-07-v1.7.5-claim-inventory.md) | v1.7.5 Goal-Stack Claim Inventory |
| [2026-05-07-v1.7.5-goal-stack-eval-prereg.md](2026-05-07-v1.7.5-goal-stack-eval-prereg.md) | v1.7.5 Goal-Stack Eval, pre-registration |
| [2026-05-07-v1.7.5-goal-stack-eval-result.md](2026-05-07-v1.7.5-goal-stack-eval-result.md) | v1.7.5 Goal-Stack Eval, result |
| [2026-05-09-v1.7.6-calibration-result.md](2026-05-09-v1.7.6-calibration-result.md) | v1.7.6 Calibration, result |
| [2026-05-09-v1.7.7-claim-inventory.md](2026-05-09-v1.7.7-claim-inventory.md) | v1.7.7 Goal-Stack Claim Inventory |
| [2026-05-09-v1.7.7-goal-stack-eval-prereg.md](2026-05-09-v1.7.7-goal-stack-eval-prereg.md) | v1.7.7 Goal-Stack Eval, pre-registration |
| [2026-05-09-v1.7.7-goal-stack-eval-result.md](2026-05-09-v1.7.7-goal-stack-eval-result.md) | v1.7.7 Goal-Stack Eval, result |
| [2026-05-09-v1.7.9-retraction-inventory.md](2026-05-09-v1.7.9-retraction-inventory.md) | v1.7.9 minus-10pp Retraction Claim Inventory |
| [2026-05-09-v1.9-pre-commitment-retraction.md](2026-05-09-v1.9-pre-commitment-retraction.md) | v1.8 prereg "v1.9 LongMemEval Cross-Validation" pre-commitment, RETRACTED |

### Adversarial categories (2026-05)

| Doc | Title |
|---|---|
| [2026-05-09-v1.8.0-adversarial-eval-prereg.md](2026-05-09-v1.8.0-adversarial-eval-prereg.md) | v1.8.0 Adversarial-Categories Eval, pre-registration |
| [2026-05-09-v1.8.0-adversarial-eval-result.md](2026-05-09-v1.8.0-adversarial-eval-result.md) | v1.8.0 Adversarial-Categories Eval, result (descriptive) |
| [2026-05-09-v1.8.0-category-authoring-iteration-log.md](2026-05-09-v1.8.0-category-authoring-iteration-log.md) | v1.8.0 Category Authoring Iteration Log |
| [2026-05-09-v1.8.0-claim-inventory.md](2026-05-09-v1.8.0-claim-inventory.md) | v1.8.0 Claim Inventory + Retraction-Compliance Check |
| [2026-05-09-v1.8.0-jaccard-verification.txt](2026-05-09-v1.8.0-jaccard-verification.txt) | Jaccard overlap verification, raw output |

### Site and release checks (2026-05)

| Doc | Title |
|---|---|
| [2026-05-24-card4-dryrun.md](2026-05-24-card4-dryrun.md) | Card 4 dry run |
| [2026-05-24-card4-dryrun-result.json](2026-05-24-card4-dryrun-result.json) | Card 4 dry run, raw result |
| [2026-05-24-card4-20seed-result.json](2026-05-24-card4-20seed-result.json) | Card 4, 20 seeds, raw result |
| [2026-05-24-e5-lighthouse-report.md](2026-05-24-e5-lighthouse-report.md) | E5 Lighthouse audit report |
| [2026-05-24-e5-lighthouse.json](2026-05-24-e5-lighthouse.json) | E5 Lighthouse, raw JSON |

## Reproducing a number

The LongMemEval harness, the data and its SHA-256 are in
[`benchmarks/`](../../benchmarks/). Each result document names the command that
regenerates its own table. A document that does not name one is descriptive and is
marked as such in its title.
