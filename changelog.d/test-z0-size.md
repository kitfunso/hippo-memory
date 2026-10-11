### Added

- **Z0 sizing script `scripts/token-eval/z0-size.mjs`.** It reads calibration records, estimates the repository, family and seed spreads and the not-applicable rate, and simulates the analyzer's own bootstraps and verdicts at Holm's strictest level to find the families and tasks each hypothesis needs. For minimum effects of 15, 20 and 25 points it reports the sizes, the sessions and the days of plan usage per tool. The repository spread is taken at a one-sided upper bound, and the per-day quota is a flag with a placeholder default.
