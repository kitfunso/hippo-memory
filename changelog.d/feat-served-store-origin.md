### Added

- **A store's `config.json` can set `"sharedStore": true` when a team server serves it.** The server's folder is then no caller's project. A write that names no project is stored with no project (NULL), not with the folder's project. Rows with no project stay out of every project's prompt context. Before, a server folder with no project marker stamped them user-global, so every project saw them. Once a process reads the flag as true, it stays true until the process ends, so a broken edit cannot turn it off.
- **`POST /v1/memories` takes `project: { name, aliases? }`, and `remember()` takes the same `project` option.** The row stores `name` as its project. `aliases` are checked against the caps and not stored, and other keys, `legacy_name` included, are ignored. A blank name, more than 10 aliases or a name over 256 characters answers 400 and writes nothing. The CLI thin client sends no project, so a routed `hippo remember` stores the same project as a direct one.
- **`GET /v1/context` on a shared store takes the caller's project as `project` and repeated `alias` query parameters.** Without them it answers 400. Other stores ignore both parameters. MCP `hippo_context` refuses a shared store and points to `hippo_recall`, because the tool cannot name a project yet.
- **`hippo-memory/server` exports `isSharedStore(hippoRoot)`,** so an add-on that serves a team store can check the flag before it starts.

### Changed

- **Every context read of a flagged store follows the shared-store rules, with or without the `{ sharedStore: true }` option.** A read whose caller has no project throws `BadRequestError` instead of returning every row.
- **`hippo sync` refuses a shared store.** It would copy one person's global memories into a store that every member reads. A row with no project that is promoted or shared from a shared store keeps no project in the global store.
