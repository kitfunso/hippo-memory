### Fixed

- **The Python SDK now defaults to `http://127.0.0.1:6789`, the port `hippo serve` binds.** It defaulted to 3737, so `Hippo()` and `HippoSync()` with no `base_url` could not reach a default server. A test now reads `DEFAULT_SERVER_PORT` from the server source and fails if the two drift apart.
