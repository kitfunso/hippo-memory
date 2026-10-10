### Changed

- **Internal:** agent-memory sync, `hippo doctor` and `hippo projects` open their database through `src/store/handles.ts`, and the agent-home path helpers live in `src/util/agent-homes.ts`, which cuts the hooks/agent-memories and trust/consolidate import cycles.
