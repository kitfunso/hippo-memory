### Changed

- **Internal:** the agent-home path helpers live in `src/util/agent-homes.ts` and `mergedSuccessor` in `src/util/merged-row.ts`, which cuts the hooks/agent-memories and trust/consolidate import cycles; the store-port ratchet now also counts files outside the data layer that name a raw database handle type.
