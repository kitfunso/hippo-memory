### Changed

- **The size ratchet now scans `scripts/` as well as `src/`.** Existing offenders under `scripts/` are frozen in `.size-baseline.json` and can only shrink. No runtime behaviour changes.
