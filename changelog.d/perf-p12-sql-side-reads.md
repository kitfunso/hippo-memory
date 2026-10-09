### Performance

- **Whole-store reads that filtered or counted in JS now do it in SQL.** `hippo_status` reads one aggregate row and a conflict count instead of a strength row per memory (10,006 rows down to 8 at 10,000 memories). The session digest reads only the live session-digest rows of other sessions (10,113 rows down to 63). The dashboard's memory detail reads the conflicts naming that memory in one query and their other sides in one batch (210 statements down to 11 with 20 conflicts). Sleep's dedupe pass reads only current distilled rows.
- **API-key hashing on a server cache miss runs off the event loop.** The scrypt check now runs on the thread pool, so other requests keep moving while a key is verified. The CLI's synchronous check is unchanged.

### Changed

- **A DAG cluster's members are re-linked in one transaction.** Each member still gets its audit row and its mirror file. If one member's write is refused, none of that cluster's members is linked; before, the members written ahead of the refusal stayed linked.
