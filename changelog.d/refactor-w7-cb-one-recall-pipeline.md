### Changed

- **Internal:** recall's band ranker, the MCP wide ranker, the CLI ranking core and context now pick physics or hybrid search in one function, `searchByEngine` in `src/search/engine.ts`. A golden test pins the ids and order of 23 recalls across the three recall rankers, so the merge moved no ranking.
- **Internal:** the CLI ranking core writes the second store's recall rows through a store named for that root when one is given, the way it writes the first store's rows, instead of always opening hippo.db there.
