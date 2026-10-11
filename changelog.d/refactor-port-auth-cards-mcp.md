### Changed

- **Internal:** the MCP server reaches the store only through the api layer, and a busy store maps to 503 in the shared error map that the HTTP server and MCP both use. The memory routes leave the last-recall capability check and the graph entity cap to the api functions they call. Replies are unchanged.
