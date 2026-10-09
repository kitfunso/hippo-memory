### Changed

- **The compactions SQL now lives in `src/store/compactions.ts`.** Internal only: `compaction-record.ts` and `project-merge.ts` call named store functions instead of preparing statements; behaviour is unchanged.
