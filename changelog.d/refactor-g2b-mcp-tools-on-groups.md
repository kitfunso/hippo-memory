### Changed

- **The MCP tools `hippo_predict_baserate`, `hippo_assemble` and `hippo_drill` run on a served store that has their group.** The baserate tool reads through the `predictions` group, the other two are marked for `dagReads`, and the baserate read now states `ORDER BY id`, the order its index already gave. Internal only, no runtime behaviour changes.
