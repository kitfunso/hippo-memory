### Changed

- **Library, server, MCP, connector and hook warnings now go through the `HIPPO_LOG` logger.** Lines that printed before still print at the default level, now as `[hippo] warn: ...` or `[hippo] error: ...` on stderr. Fallbacks that used to fail silently (a missing git repo, an unreadable JSON column, a failed judge or rerank model load) now log at `debug`. Printed command results, the dashboard banner and the delivery-ledger hook line keep their old format.
- **`hippo refine` says why a refinement failed.** A failed request, a non-2xx answer, an unreadable body or a too-short reply now logs one warning instead of being dropped.

### Security

- **MCP no longer sends internal error text to clients.** On both the stdio server and `POST /mcp`, a typed error (not found, bad request, forbidden, conflict) keeps its message. Any other error answers `internal server error (request id <id>)` with the id in `error.data.requestId`, and the real error is logged at `error` with that id.
