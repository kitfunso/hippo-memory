### Changed

- **Hook commands open each store once per run.** `hippo context` (the per-prompt hook), `compact-resume`, `pre-compact`, `post-compact` and `capture-error` used to open the same SQLite store up to 7 times, re-running its pragmas, migration check and mirror cleanup on each open. They now reuse one connection per store and close it when the command ends. Output is unchanged.
