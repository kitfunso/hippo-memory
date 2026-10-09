### Changed

- **Four internal modules moved down to the layer that uses them.** The agent-memory tool list, the search result types and the hook blocks now live in `src/core/` and `src/hooks/`, and the failure outcome types sit with the failure log. Six upward imports are gone from `.layers-baseline.json`. No behaviour changes.
