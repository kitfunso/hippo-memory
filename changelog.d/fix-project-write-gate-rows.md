### Security

- **The project write gate now judges a write to an existing memory by that memory's project.** Supersede, forget, raw archive, outcome and conflict resolve ask `projectWriteGate` with the row's own origin project, or null when it has none. A conflict resolve with `rejectLoser` also asks with null, because it removes every memory in the tenant that holds the same text. A row the caller cannot read still answers 404 first, and a personal row is never asked. Before, only a new memory asked the gate. `ProjectWriteCall.project` can now be a memory's stored origin, which never passed the caller-project name check (for example an older name with upper case). A gate should compare it as an opaque string.

### Added

- **`POST /v1/outcome` and `hippo_outcome` say how many ids the gate refused.** The reply gains `refused` only when the gate refused an id. Those ids are skipped and the rest still apply, so the call never fails on them. A server with no gate answers as before.
