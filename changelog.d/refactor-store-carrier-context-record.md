### Changed

- **`getContext` records a recall on one path.** The hippo.db and store-served record steps are one body on the store carrier, and the store-port ratchet now counts zero twin functions. The trace is written before the rows are strengthened, on one database handle.
- **A context call no longer reads every memory row before it saves its last recall.** With 10,000 memories a `hippo context` call with no query reads about 4,100 rows where it read about 14,100.
- **A context call strengthens only the calling tenant's rows.** A row another tenant holds under the same id as a returned global row is no longer counted as retrieved.
- **A failed trace write on an empty context reply logs one message.** A store that cannot be opened now logs `recall trace write failed`, where it logged `recall trace connection failed`.
