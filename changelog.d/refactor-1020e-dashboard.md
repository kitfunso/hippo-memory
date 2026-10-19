### Security

- **`hippo dashboard` no longer prints its access token on a terminal.** The start line names the owner-only `dashboard.url` file in the hippo root that holds the URL with the token.
- **The dashboard refuses a request another site starts before it reads the token.** The page that moved a cross-site visit on is gone, and its session cookie authenticates no `/v1` route.
- **The dashboard serves a static file only from inside the built app's folder.** A path with `..`, an encoded `..`, an absolute path or a link that leaves the folder is refused.

### Changed

- **`hippo dashboard` runs on the API server's listener code.** It shares the request ids, deadlines, body limits, drain and error replies of `hippo serve`, and builds its snapshots on a reader thread so a large store no longer blocks the event loop. Every `/api` path and JSON body is unchanged.
- **3.0 break: dashboard error replies take the server's shape.** 401 and 403 answer JSON, a body over 4 KB is a 413, and a failure is a 500 with `requestId`.
