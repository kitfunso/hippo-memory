### Changed

- **Sleep extracts facts with up to four model calls at once.** Writes, counts and error reports still run in input order, and a permanent failure stops new calls and skips the same rows as before.

### Fixed

- **A session end whose sleep step throws no longer leaves an exit listener behind.** The re-read log is written when the step ends, not at process exit.
- **Dashboard memory pages, stale-conflict resolution, pinned context reads, report reads and summary reads do less work per call.** Each reads in bounded pages or from one evaluation of the kept rows; the output is unchanged.
