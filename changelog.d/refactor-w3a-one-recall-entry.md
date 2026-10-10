### Changed

- **Internal:** the synchronous `recall()` in `src/api/recall.ts` is gone; `retrieve()` is the one recall entry, and its tests, plus two benchmarks, now call it.
