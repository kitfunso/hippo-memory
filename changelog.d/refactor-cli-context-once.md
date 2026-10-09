### Changed

- **Internal:** the CLI now resolves its tenant once per command and builds its api context in one function (`cliApiContext`), instead of repeating both across the verb files. No verb reads a different tenant, writes a different audit actor or prints different text. A new `tenantResolvesInCli` counter in `scripts/check-store-port.mjs` reports the remaining direct tenant lookups.
