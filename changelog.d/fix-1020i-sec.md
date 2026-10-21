### Security

- **Server key checks are bounded more tightly.** An unknown, revoked or expired key id now spends the address's failed-auth budget like a wrong secret, and one address holds at most two slots of the scrypt queue.
- **Dashboard session cookies expire on the server.** The cookie carries a signed issue time, and a cookie older than one day is refused.
- **Every `/v1` JSON reply is sent with `Cache-Control: no-store`.** Before, only recall with continuity was.
- **A reserved actor name cannot hide behind a format character.** A resolver subject with a zero-width, bidi or line-separator character is refused.
- **GitHub webhook replay protection survives a restart.** The delivery hold now lives in the store, as Slack's does, so a replayed delivery after a restart answers 409.
- **Windows `.cmd` shim arguments keep a trailing backslash.** A backslash run before a quote or the closing quote is doubled.
