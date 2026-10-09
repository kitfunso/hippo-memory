### Changed

- **The CLI object verbs share one list, status and flag path.** Internal only: process, policy, skill, brief, note, decide and incident now use `src/cli/object-verbs.ts`, so the "Invalid --status" message and the empty-string flag read each live in one place. Output is unchanged.
