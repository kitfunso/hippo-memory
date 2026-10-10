### Changed

- **Internal:** CI now fails when a promise call in `src/` is neither awaited nor handled. Since CLI verbs throw to exit, a dropped `await` would turn a clean exit into an unhandled rejection.
