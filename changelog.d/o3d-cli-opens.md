### Changed

- Internal: seven `hippo` CLI functions (`auth list`, `embed --reset-physics`, the `status` physics line, `slack workspaces add|list|remove` and the CLI audit write) no longer open hippo.db themselves; the data layer opens it for them. No output or behaviour changes.
