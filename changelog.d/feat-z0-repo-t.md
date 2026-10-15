### Changed

- **Z0 verdicts and gates use a t test over repositories (Amendment 1).** `src/eval/repository-t.ts` adds a hand-written Student t distribution, the one-sample t test over repository values, a cluster-robust ratio and Cox's interval for the mean of per-repository ratios. H1, H2, attribution, G2 and H4 read these tests, and the two-level bootstrap prints beside each one for comparison only. Holm now runs over H1 and H2 at 0.05, and H3 prints its ratio with no verdict. The sizing script simulates the t tests at 0.05/2 and no longer takes `--iterations` or `--search-iterations`.

### Added

- **Z0 H4 skew check `scripts/token-eval/z0-skew-check.mjs`.** It counts how often the H4 cost gate passes at a true cost ratio of 1.10, against the prereg's one-sided 5%. With skewed repository costs Cox's interval passes 3.1% to 3.8% of runs; the analyzer doc records the table and the gate's power.
