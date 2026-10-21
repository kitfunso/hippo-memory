### Changed

- **`POST /v1/memories` accepts an optional `salienceGate` boolean.** With `true`, a write the salience gate judges not worth keeping answers `{ "skipped": { "reason", "score" } }` and stores nothing, and a weak one starts weakened (`startedWeak` in the reply). Without the field, the route stores as before. `hippo remember` sets it on both its routed and its direct path, so the two now store the same things.
- **The 400 for a bad `kind` lists the allowed kinds** instead of echoing the value sent.
