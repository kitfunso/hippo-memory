### Added

- **Add the Z0 analyzer, `scripts/token-eval/z0-analyze.mjs`.** It validates `z0-record/1` runs against the runner's plan, applies the pre-registered filters and gates G1-G5, and seals H1-H4 behind blind codes until a committed drop list and grading file allow an unblind. Eval tooling only; no runtime or CLI change.
