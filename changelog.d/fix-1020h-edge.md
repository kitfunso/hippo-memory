### Security

- **A refused bearer token from your auth resolver now spends the address's failed-auth budget.** Wrong resolver tokens from one address get 429 after the same number of tries as wrong API keys; an upstream outage (503) is not charged.
- **The key-mint reply carries `Cache-Control: no-store`.**
- **A dead-letter row is read and counted per tenant.** `connectorEvents.deadLetter` and `markDeadLetterRetried` take the tenant id, so another tenant's id answers absent.
- **The Windows Codex wrapper starts the npm shim's script with Node.** It no longer starts PowerShell with `-ExecutionPolicy Bypass`.
- **The rate limiter keeps a throttled bucket when the table is full**, so a flood of new addresses cannot reset a throttled caller.
- **On Windows `hippo dashboard` writes `dashboard.url` under the global hippo folder in your profile**, since a file mode does nothing there.

### Changed

- **`AuthResolver` takes an optional second argument, an `AbortSignal` aborted at the resolver deadline.**
- **Failures that were logged as text now carry the error class and stack:** audit-write failures, resolver failures, session-end failures, a failed request-store close, an unreadable `.git` config and a failed pre-compact run.
- **The once-only log keys forget the least recently seen key when 1,000 are held**, instead of logging every new key at debug.
