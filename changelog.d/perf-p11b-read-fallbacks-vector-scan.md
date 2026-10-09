### Changed

- **The nearest-vector scan no longer holds the event loop for its whole run.** It scores 256 rows, then lets other work run, so a server answering a hybrid recall over 10,000 vectors blocks for about 2 ms at a time instead of about 35 ms. Ids, order, scores and tie-breaks are unchanged.
- **A query that matches nothing now costs the same in a store of any size.** The substring (LIKE) match behind FTS5 tested every row of the tenant; it now tests the newest 2,000 admitted rows. At 10,000 rows a no-match query tests 2,000 rows instead of 10,000.
- **Behaviour change: in a store with more than 2,000 admitted rows, a row that matches only as a part-word (`caf` in `cafe`) is found only if it is among the newest 2,000.** Whole-word matches go through FTS5 and still cover the whole store. A store where FTS5 cannot run searches its newest 2,000 rows only.
