### Changed

- **Internal:** the embedding index and the promote check no longer open the database themselves. `src/embeddings.ts` and `src/api/promote.ts` call named functions in `src/store/vector-writes.ts` and `src/store/tenant-lookup.ts`; behaviour and the published exports are unchanged.
