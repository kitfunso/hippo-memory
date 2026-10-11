### Changed

- **Internal:** the graph writers take the caller's database handle only (`insertEntityRow`, `updateEntityRow`, `insertRelationRow`), so a write inside a rebuild transaction can no longer open its own connection and commit outside it.
- **Internal:** choosing an embedding provider, reading its config and checking its API key moved out of the store into `src/search/embed-memories.ts`; the store keeps only the vector index identity. `embedMemory` and `embedAll` keep their exported signatures.
- **Internal:** `hippo reject` and `hippo invalidate` reach the reject and invalidation flows through `src/api` (`rejectOnHost`, `invalidateMemories`).
