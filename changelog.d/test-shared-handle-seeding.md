### Changed

- **Store-heavy test and eval-script seed loops share one SQLite connection.** Seeding with a close per write paid a WAL checkpoint each time and pushed Windows CI tests toward the 30 s budget. The E1 lifecycle driver and the lifecycle-stress builder now do the same. No product code changed.
