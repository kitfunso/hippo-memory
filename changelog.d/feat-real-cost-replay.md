### Added

- **`scripts/token-eval/real-cost.mjs` prices hippo's memory text against built-in MEMORY.md on your own sessions.** It replays Claude Code transcripts at $0 under a 1h prompt cache, counting compactions, cache expiries and hippo command output, and prints dollars and the MEMORY.md size where the two cost the same. It prints counts and dollars only, never transcript text.
