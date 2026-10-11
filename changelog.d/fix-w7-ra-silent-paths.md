### Fixed
- **Embedding failures after the first no longer vanish:** a repeat failure is counted and reported as one warn line at most once a minute.
- **A failed `/health` probe no longer deletes the pidfile unless it proves no server is there:** a refused connection or a non-JSON body still clears it; any other error keeps it and logs a warn.
- **`runWatched` has a 30 minute deadline:** a hung transfer command is killed and the call rejects with `RunWatchedTimeoutError`; an optional second argument sets the deadline.
- **The store executor logs a worker that fails to terminate** instead of dropping the rejection.
- **The thin client rejects a 2xx reply that is not a JSON object** with a `MalformedReplyError` naming the route.
