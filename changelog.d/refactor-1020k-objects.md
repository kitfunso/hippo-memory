### Changed

- **The objects, sessions, cards, keys and quarantine store groups take a kind in place of a method per kind: 55 methods became 28.** An incident, policy, skill or prediction goes through `saveObject`, `closeObject`, `objectById` and `listObjects`; a snapshot, event, handoff or working-memory item through `sessions.save`, `read` and `clear`; a key change through `keyWrites.changeApiKey`; a quarantine decision through `quarantine.decideQuarantined`. Rows, order, refusal and error text, audit rows, HTTP JSON, MCP text and CLI output are unchanged. `docs/UPGRADING-3.0.md` lists each old call and its new form.

### Removed

- **The `predictions`, `keyAudit` and `keyGrants` store groups, and `cards.load` and `cards.runs`.** Their methods now live on `objects` and `keyWrites`, and `cards.detail` answers the card and its runs.
