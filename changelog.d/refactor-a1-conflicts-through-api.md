### Changed

- `hippo resolve` and the MCP `hippo_resolve` tool now refuse a conflict whose memories are no longer live (superseded, archived or quarantined) and a `--keep` id outside the pair, as the dashboard already did.
- `hippo resolve` now applies the same personal-row check as MCP and the dashboard, so an unowned admin cannot resolve a conflict holding someone's personal memory.
- `hippo resolve` reports a refused conflict as `Error: <reason>` with exit code 1, naming why it was refused.
- **Internal:** `resolveMemoryConflict` in the api layer owns conflict resolution for MCP and the CLI; the dashboard moves to it in a follow-up.
- **Internal:** `reject` by id, `authKeyTenant` and the MCP share tool read through the store port, so a served store answers them.
