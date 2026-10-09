### Changed

- **Internal:** `recall()` now reads and writes through the same store method names and argument object as `retrieve()`, the physics-or-hybrid ranking choice is one function, and the pass-through `buildSuppressionSummary` helper is gone (callers build the `RecallSuppressionSummary` directly). Results, rows written and audit rows are unchanged.
