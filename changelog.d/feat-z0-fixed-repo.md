### Changed

- **Z0 tests hold the repositories fixed and make the family the unit (Amendment 2).** `src/eval/repository-t.ts` adds `fixedRepositoryT`, a t test that fits family and seed effects inside each repository and pools the mean squares, and `fixedRepositoryRatioT`, its cost-ratio form on the log scale. H1, H2, attribution, G2 and H4 read them; the bootstrap keeps the repositories and resamples families inside each. `clusterRatioT` and `coxRatioT` are removed.
- **The Z0 sizer searches families per repository and seeds per arm.** `scripts/token-eval/z0-size.mjs` sizes at the calibration's point estimates, reports power with every spread at its 80% upper bound, and prefers a design that passes there too. The H4 discordance uses a Clopper-Pearson bound. `--repo-bound` is gone.
- **The H4 skew check tests the log interval.** `scripts/token-eval/z0-skew-check.mjs` compares the log and symmetric ratio intervals at a true cost ratio of 1.10.
- **Z0 records and plan cells take seeds up to 9.** A seed above 3 is accepted only for A1, A2, A5, X2 and X3, the arms the seed rule sizes; A0, A4 and X4 stay at two seeds.

### Added

- **Z0 seed rule `scripts/token-eval/z0-seed-rule.mjs`.** After wave 1 it picks how many seeds the rule arms get from sign-free spreads only, and prints counts, the stop flag and input hashes, so it stays blind to the effect.
- **`ab-run.mjs --seed-rule FILE` runs wave 2.** It reads the seed rule's output, refuses a stop, and runs seeds 4 up to each listed arm's count with its own plan file.
