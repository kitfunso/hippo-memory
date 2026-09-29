### Fixed

- **Projectless recall and ordinary context now find the global store.** CLI store discovery falls back outside projects and counts each store once. Context reads global memories and configuration without borrowing global project task state. Real-command fixtures prove ordinary recall and Codex pin delivery exclude a foreign handoff, and global hook opt-out is respected.
- Refresh the UI's Undici lock entry to the patched release so the dependency security audit passes.
