### Changed

- **Locks are held by the operating system, a timed-out command takes its whole process tree, and old chat cursors are pruned.** Replay, session-worker and embedding locks cannot be taken over by two processes; sleep removes cursor files older than 30 days.
