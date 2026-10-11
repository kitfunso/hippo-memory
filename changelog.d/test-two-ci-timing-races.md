### Fixed

- **Two tests no longer fail on a slow CI runner.** The stream-expiry test now opens the stream with a live key and expires the key afterwards, so a slow runner cannot reach the open after the key has run out. The Slack smoke test now ingests through one connection and states its own time limit, so it no longer times out on Windows.
