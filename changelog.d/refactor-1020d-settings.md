### Changed

- **The CLI, the server and the MCP server read hippo's behaviour variables and pass the values down.** Search, recall, sleep and strength scoring no longer read the environment themselves. A library caller sets the values through `config.runtime`, the search options and the `lossAversionRatio` option of `calculateStrength`; the CLI and server behave as before.
