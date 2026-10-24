### Changed

- **The published `isSharedStore` and `resolveProjectIdentity` read the disk on each call, with no answer kept for the process.** A server, a CLI command or stdio MCP loop, the sleep child, the published entries and each store object now keep their own project walks and shared-store flag in a `Host` of their own, so a store once read as shared stays shared for that root and two roots in one process never share an answer.

### Internal

- **Disk, environment and process reads moved out of `src/base` into a new `src/host` layer, and domain and api get those answers from the machine port or their caller.** `scripts/check-domain-io.mjs` now fails an `fs`, `os` or `child_process` import in `src/base`, and a run-time `src/host` import in `src/domain` or `src/api`.
