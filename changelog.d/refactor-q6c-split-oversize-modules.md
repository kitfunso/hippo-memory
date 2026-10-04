### Changed

- **Six oversized modules now live in folders of smaller files, with behaviour unchanged.** `consolidate.ts`, `capture.ts`, `hooks.ts`, `importers.ts`, `graph.ts` and `predictions.ts` moved into `src/consolidate/`, `src/capture/`, `src/hooks/`, `src/importers/`, `src/graph/` and `src/predictions/`. Code moved byte for byte, and the package entry point exports the same names. No source file in these folders is over 800 lines.
- **The single graph writer is now `src/graph/write.ts`.** `scripts/check-graph-writes.mjs` allows graph table writes only in that file.
