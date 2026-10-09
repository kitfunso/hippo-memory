### Changed

- Internal: nine places in the API, MCP, consolidate and vault-import code that opened hippo.db for one read or one audit row now call the store layer, which opens it for them.
