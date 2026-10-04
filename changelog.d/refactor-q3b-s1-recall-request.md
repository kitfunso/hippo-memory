### Changed

- **MCP `hippo_recall` now rejects an empty `query`** with an `isError` result, as `GET /v1/memories` rejects an empty `q`.
- **MCP `hippo_recall` now rejects a `scorer_window` above 1,000** with an `isError` result, the same cap HTTP applies.
- **MCP `hippo_recall` now rejects a negative `fresh_tail_count`** with an `isError` result; it used to ignore it.
- **MCP `hippo_recall` now caps `fresh_tail_session_id` at 256 characters**, as HTTP does.
- **MCP `hippo_recall` now checks `limit` and `mode` by the HTTP rules** and answers a bad value with an `isError` result; it still ranks its own 50-row band in the store's search mode.
- **MCP `hippo_context` now caps `scope` at 256 characters and rejects a `limit` of 0 or less**, as `GET /v1/context` does.
- HTTP recall and context answers are unchanged: both surfaces now share one set of input checks in `src/api/recall-request.ts`.
