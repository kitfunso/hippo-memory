### Changed

- **The six longest functions in `src/api` are split into named stages.** `getContext`, `recallFrom`, `sleep`, `assemble`, `drillDown` and `supersede` each now read as a short list of stage calls, and no function in `src/api` runs past 80 lines. `getContext`'s three selection branches (pinned-only, strongest-first and search) moved to `src/api/context-select.ts`. Ranking order, scores, budgets, audit and trace rows, and the ambient line are unchanged, and `oneCopyPerMemory` is still exported from the same place.
