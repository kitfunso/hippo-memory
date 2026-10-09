### Changed

- **Internal:** The scheduler tests now run on every platform against real temp folders, and the filesystem test seam in `src/cli/scheduler.ts` is gone. Two fresh-tail recall cases now assert the rows returned, and two log tests prove an absence with a positive control instead of a fixed sleep.
