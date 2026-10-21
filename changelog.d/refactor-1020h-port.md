### Changed

- **`HippoConfig.physics` names its fields in camelCase.** `G_query`, `G_memory` and `K_repulsion` are now `gQuery`, `gMemory` and `kRepulsion`, and the other snake_case physics fields follow, such as `clusterTopK`. A `config.json` keeps its keys: `physics.G_query` still sets `gQuery`. Code that reads `config.physics.G_query` from `hippo-memory/store-kit` reads `config.physics.gQuery`, and `hippo support-bundle` shows the effective config under the new names; see `docs/UPGRADING-3.0.md`.
