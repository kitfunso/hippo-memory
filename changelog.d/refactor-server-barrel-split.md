### Changed

- **The HTTP route table and its dispatch helpers now live in `src/server/route-table.ts`, and the server boot in `src/server/boot.ts`.** `src/server.ts` is only the published `hippo-memory/server` export block. No exports or runtime behaviour change.
