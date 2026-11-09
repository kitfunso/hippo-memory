### Fixed

- **A compaction summary saved from the spool is now stored once.** Before, if the spool file's claim could not be removed (an antivirus or indexer held it) or the process died right after the save, the next replay saved the same summary again as a second compactions record. Now the replay finds the first record and reuses it, so you see one record per summary.
