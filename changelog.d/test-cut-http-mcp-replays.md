### Tests

- **The route status snapshot is now a literal table.** `tests/server-route-status-table.test.ts` lists each route's status and error text for a bad key and for loopback, and asserts one field of each valid reply, in place of a 1,000-line snapshot.
- **Replayed HTTP and MCP cases are gone.** Six test files and a handful of declarations re-asserted failures that a named test already catches; their few unique assertions moved into those tests first.
- **`mcpContextFor` is no longer exported** from `src/server/mcp-http.ts`; no test calls it.
