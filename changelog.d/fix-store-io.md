### Changed

- **The package ships one CLI and no source maps.** The benchmark build compiled `src/` a second time into `dist/src`, so the package carried two copies of the CLI and every `.map` file. Benchmarks now build into `dist-bench/`, which is not packed, and the build clears `dist/` first. Anything that ran `dist/src/cli.js` should run `dist/cli.js`.
- **Search reads the embedding index once per query.** It parsed `embeddings.json` twice, once to check the model and once for the vectors.

### Fixed

- **Two hippo processes no longer lose each other's embeddings.** `embeddings.json` is rewritten whole on every embed, and the only guard lived inside one process, so a CLI `remember` while the MCP server embedded could drop a vector. Writers now take a lock file, `embeddings.lock`, that holds the writer's pid and a random token. A lock left by a dead process is broken, even when a restarted container gives a new process the same pid. Worker threads in one process wait for each other, a writer removes only its own lock, and a waiter gives up after 10 s. A background embed that gives up prints one line, and `hippo embed` fills the gap.
- **A failed mirror write no longer reports a saved change as failed.** `index.json`, `stats.json` and the markdown mirrors are written after the database commits. When one of those writes failed (a file held open on Windows, a full disk), `remember`, batch writes, deletes and conflict resolution threw although the change was saved, and a retry could save it twice. They now warn and succeed, and a markdown file that could not be deleted is named in the warning.
- **Reads no longer write files.** Loading the index or the stats rewrote `index.json` and `stats.json`, so even `hippo status` changed files on disk, and two readers in different processes could race on the same file. Only writes refresh them now.
- **An older hippo stops when a newer one upgrades the store under it.** The check that refuses a database stamped for a newer hippo ran once, before migrations. A process that waited for the migration lock while a newer binary upgraded the store carried on with a schema it does not know. The check now runs again under the lock, and an unreadable stamp refuses the open instead of passing.
- **Every reranker returns the same number of results.** `hybridSearch` passed 50 candidates to the reranker without saying how many, so the LLM reranker kept 20, Jev kept 40, and the rest were dropped. The reranker now gets the same count. A library caller that wants Jev's measured pool of 40 passes `rerankerOptions: { topK: 40 }`; the CLI already does.
- **A broken full-text index says so.** When SQLite's full-text index could not be set up, search switched to slower LIKE matching without a word. It now prints a warning with the reason.

### Documentation

- **`index.json` stops being refreshed on every write in 1.46.0.** SQLite (`hippo.db`) holds the store and `index.json` is a mirror of it. From 1.46.0 the mirror comes only from an explicit export. Read the store through the CLI, the MCP server or the HTTP API instead of `index.json`.
