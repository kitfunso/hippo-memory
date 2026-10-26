### Changed

- **Strength scoring takes one model value, and lower layers take their time from the caller's clock.** Eval switches build another `StrengthModel` at the root, so core math has no eval flag. A `Context`'s `infra` now carries a `clock`. See `docs/UPGRADING-3.0.md`.
