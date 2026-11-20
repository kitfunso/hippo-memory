### Fixed

- **The MCP Registry accepts the release.** The registry refused 3.10.0 because `server.json` listed the npm package without its own version. The package entry now carries it, `sync-version.mjs` sets it with the top-level version on every release, and `check-manifest-versions.mjs` fails when they differ.
