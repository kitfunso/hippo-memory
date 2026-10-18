### Changed

- **The MCP `hippo_status` tool now counts a memory as at risk under strength 0.2, not 0.1, so its figure matches `hippo status` and the dashboard.** The line reads `At risk (<0.2)`; the strength bands, the SQLite busy codes and the git call timeouts each have one named constant.

### Fixed

- **`hippo handoff show` and `hippo resolve` now refuse an id such as `12abc` or `1.5` instead of reading it as 12 or 1.** Both use the strict whole-number id check the other verbs already use.
