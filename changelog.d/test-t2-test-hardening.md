### Fixed

- **A memory tag that contains a comma now reads back as one tag.** The markdown mirror quoted such a tag on write, but the reader split it at the comma, so `"a, b"` came back as two broken tags. The reader now honours quotes and escapes in inline lists and in `- ` block lists. Line breaks inside a frontmatter value are written as `\n`, so they no longer break the file. A string field that reads as `true`, `null` or a number is quoted, so it comes back as a string.

### Changed

- **Timing-based tests now wait on events, not sleeps.** The cold-store concurrency test releases its workers after each one reports ready. The embeddings lock tests drive the waiter's poll with fake timers and check that the fetch runs only after release. Dashboard, CLI and stub servers bind port 0 and read the port the OS gave them. The physics benchmark scores every query once, so its totals no longer depend on test order, and its summaries now assert the classic and physics results.
- **The no-key request from a remote address is now tested end to end.** `/v1/memories` and `/mcp` return 401 and `/v1/sleep` returns 403 when the peer address is not loopback. The BM25 ranking test checks the exact top result, and the random ISO-sort test prints the seed that replays it.
