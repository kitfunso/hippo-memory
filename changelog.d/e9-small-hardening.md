### Security

- **`GET /ready` now runs at most one store read per second, whatever the number of callers.** A health prober still gets the same reply and never a 429.
- **Working memory (`hippo wm`, `wmPush`, `wmRead`, `wmClear`, `wmFlush`) is now scoped by tenant.** Existing rows belong to the `default` tenant and read exactly as before; each call takes an optional `tenantId`.
- **`hippo serve --tls-cert` now sets TLS 1.2 as the minimum version explicitly.** This is the same floor Node used by default.
- **The `runWatched` doc now states that its command string runs in a shell.**
