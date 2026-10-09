### Changed

- **Internal:** `scripts/z6-supersession-eval.mjs` is 584 lines instead of 1,499. Its fixture contract, scoring, output parsers and selftest moved to four modules under `scripts/z6-supersession/`; the runner, its pre-flight guards and every flag stay in the entry file. `runScenarioArm` in that script and `main` in `scripts/z1c-eval.mjs` and `scripts/z0-capture-eval.mjs` are each cut into named steps under 80 lines. No behaviour change: fixture ids, the split, selftest output and recorded hashes are the same.
