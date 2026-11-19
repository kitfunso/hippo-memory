### Added

- **A memory note that Claude Code writes reaches hippo within seconds.** `hippo init`, `hippo setup` and `hippo hook install claude-code` now add a PostToolUse hook, `hippo note-written`. When Claude Code writes a `.md` note in `projects/<name>/memory/`, the hook starts a detached worker that imports the session's notes and logs one line to `~/.hippo/logs/note-written.log`. An `if` filter keeps Claude Code from starting hippo for any other write, and the hook itself exits at once for any path that is not a note. Run `hippo hook install claude-code` once to add it to an existing install.

### Changed

- **`hippo post-compact` imports the session's agent notes in a detached worker.** A first import can split hundreds of notes into thousands of rows, which does not fit the 10 s hook limit, and a kill rolled the import back on every try. The hook now returns at once and the worker logs its result to the same log file.
