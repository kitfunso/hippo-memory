### Changed

- **The size ratchet now scans `scripts/` as well as `src/`.** Existing offenders under `scripts/` are frozen in `.size-baseline.json` and can only shrink. No runtime behaviour changes.
- **`selftestLabeller` in `scripts/z6-supersession-eval.mjs` is split into nine named steps.** `--selftest` output is byte-identical. No runtime behaviour changes.
