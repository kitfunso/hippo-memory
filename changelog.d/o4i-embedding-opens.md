### Changed

- **Internal:** the embedding index and the promote check no longer open the database themselves. `src/store/embeddings/index.ts` and `src/api/promote.ts` call named functions in `src/store/vector-index.ts` (the renamed `src/store/vector-writes.ts`, which now holds the index reads too) and `src/store/tenant-lookup.ts`; behaviour and the published exports are unchanged.
