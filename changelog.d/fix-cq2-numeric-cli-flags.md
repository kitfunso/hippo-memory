### Fixed
- Numeric CLI flags such as `--min-mrr`, `--min-score`, `--importance`, `--days`, `--port` and `--limit` now exit 1 with `Invalid --<name>: "<value>". Must be a number.` instead of turning junk into NaN. `hippo eval --min-mrr abc` used to pass its MRR gate.
