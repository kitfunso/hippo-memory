### Changed

- **Internal: the test-only export ratchet no longer counts exports that production code uses.** `scripts/check-test-only-exports.mjs` now skips an export that a file under `scripts/` or `benchmarks/` imports, and a pure function or class that its own module calls; the baseline falls from 178 to 104. No runtime behaviour changes.
