### Added

- **`hippo unsupersede <id>` undoes a wrong supersede or a sleep mark.** A hidden memory is current again and its replacement stays. A memory sleep only marked stale (a `replaced-by:` tag) turns observed again. Either way the memory gets a `kept-current:<id>` tag, so the next sleep leaves the pair alone, and the audit log gets one `unsupersede` row.
- **`hippo explain` names the memory that replaced a row.** With `--include-superseded`, a superseded row gets a `replaced by <id> on <date>` line, and a stale row sleep marked gets `maybe replaced by <id>`. The strength line says `stale` or `replaced` when that is why the row ranks lower.

### Changed

- **A good outcome clears a sleep stale mark.** A memory marked `conflict-loser` or `replaced-by:` turns observed again when it proves useful. A row a person invalidated or a decision superseded keeps its mark.
