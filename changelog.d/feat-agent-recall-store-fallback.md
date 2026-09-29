### Fixed

- **Projectless recall and ordinary context now find the global store.** CLI store discovery falls back outside projects and counts each store once. The pinned Codex hook keeps its existing task-state boundary; an installed-command fixture proves global pin delivery without a foreign handoff.
- Refresh the UI's Undici lock entry to the patched release so the dependency security audit passes.
