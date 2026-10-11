### Changed

- **Internal:** the list-limit rule (default, ceiling, integer check) lives once in `src/util/limits.ts`; the CLI and HTTP `parseListLimit` are adapters over it and the MCP tool schema imports the shared ceiling.
- **Internal:** `pct` moved to `src/util/format.ts`; `hippo card` usage lines come from one table.
- **Internal:** `calculateStrength`, `calculateRewardFactor`, `netWrong` and `markRetrieved` no longer read the environment; entry points pass `strengthAblation()` through `DecayOptions.ablation`. Default scoring is unchanged.
