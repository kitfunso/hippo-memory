### Documentation

- **Every `/v1` route now declares its store status.** `POST /v1/memories/:id/promote` and `POST /v1/sleep` are marked `sqliteOnly` with a reason, and the store-port ratchet reads the declaration from the syntax tree. No runtime change.
