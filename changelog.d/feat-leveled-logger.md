### Added

- **Leveled logging with `HIPPO_LOG`.** A small stderr logger (`error`, `warn`, `info`, `debug`; default `warn`) prints lines as `[hippo] <level>: <message>`. Only the code this change touches uses it so far.
- **Every API response carries an `X-Request-Id` header.** The server echoes a caller's id when it is a short plain token (letters, digits, `._:-`, up to 128 characters) and makes a fresh UUID otherwise. A failed request logs one line with that id: 5xx at `error`, 4xx at `info`.

### Fixed

- **A corrupt `embeddings.json` no longer wipes every vector.** Hippo used to read an unparsable index as empty and then save over it. It now moves the file aside to `embeddings.json.corrupt-<time>-<pid>`, logs one error, and the next embed run (`hippo remember` or `hippo embed`) rebuilds every vector. A read error other than a missing file now throws instead of being treated as an empty index.
- **Hybrid search says when it drops to BM25 only.** A stale index (built by another model), a failed query embedding, or an empty query vector now prints one warning per process, with the fix where there is one.
