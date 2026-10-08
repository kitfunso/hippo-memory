### Fixed

- **A client that sends headers and then never sends the body can no longer hold a request open.** Only the key-mint route had a body deadline; `POST /mcp`, every `/v1` route that reads a body, the Slack and GitHub webhooks and the dashboard's action routes waited for as long as the socket stayed open. The shared body reader now has a deadline by default: 30 seconds, or `HIPPO_BODY_TIMEOUT_MS`. A body that misses it gets `408 Request Timeout` and the socket is closed. The key-mint route keeps its own 10 second deadline.
