### Changed

- **History moved out of `src/` comments into `docs/incidents.md` and `docs/ARCHITECTURE.md`.** Ticket codes, release tags, review notes, dates and plan paths in source comments fell from 1,093 lines to 86, and each comment now keeps only its one-line reason. The moved text is quoted under a heading per module, so nothing was lost. No code changed: the compiled output with comments stripped is byte-identical.
