### Changed

- **The MCP `hippo_recall` `recall` audit row now counts the memories it shows**, as the CLI and HTTP rows count the memories they return. It used to count the whole ranked band, so a small budget logged more results than the agent saw.
- The recall session rings and recall audit rows for the CLI, MCP and HTTP now live in one module, `src/api/recall-record.ts`. Each surface keeps its own rings, and audit rows keep their order and actors.
