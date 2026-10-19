### Fixed

- **A caught error keeps its class, cause and errno in the log.** No `catch` in `src` swallows an error it did not name: a best-effort probe goes through one named helper, and a failed `res.end()` is logged once per request. A stored JSON column or a pidfile that does not parse is read through a shape check, not a cast.
