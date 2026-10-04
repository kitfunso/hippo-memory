### Tests

- **The CI p99 recall gate now measures steady-state recall, so runner noise no longer fails unrelated PRs.** The step sends 50 untimed warm-up queries, then runs 5 rounds of 200 and gates on the median round's p99 at 60 ms. Two PRs that never touched recall had failed with a p99 near 300 ms from one stalled stretch of the runner; healthy runs measure 16 to 40 ms. A 4x recall slowdown still fails. `p99-recall.ts` gains `--warmup` and `--rounds`; the defaults keep the 10k cold-cache manual run unchanged.
