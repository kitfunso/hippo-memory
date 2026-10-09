### Changed

- **Internal:** `scripts/z6-supersession-eval.mjs` is 584 lines instead of 1,499. Its fixture contract, scoring, output parsers and selftest moved to four modules under `scripts/z6-supersession/`; the runner, its pre-flight guards and every flag stay in the entry file. `runScenarioArm` hands its label step to `labelScenarioArm` and is 73 lines instead of 95. No behaviour change: fixture ids, the split, selftest output and recorded hashes are the same.
