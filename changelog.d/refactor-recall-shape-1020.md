### Changed

- **`RecallOptions` groups its fields by the stage that reads them (3.0 break).** `retrieve` now takes `window`, `filter`, `boost`, `hints` and `trace` parts beside `query`, and the CLI ranking core's options take the same `window` and `boost` parts, so no option is declared twice. Ranking, the HTTP query string, the MCP tool arguments and the CLI flags do not change. `docs/UPGRADING-3.0.md` maps each old field to its part.
