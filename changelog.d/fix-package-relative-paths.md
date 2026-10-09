### Fixed

- **A new Codex launcher now points at a file that exists.** Since 1.61.0, `hippo hook install codex` and `hippo setup` wrote a launcher that named a missing file, so `codex` did not start. hippo also stopped putting its launcher back after a Codex update replaced it. The upgrade does not rewrite a launcher that 1.61.0 to 1.70.0 wrote: run `hippo hook uninstall codex`, then `hippo hook install codex`.
- **`hippo dashboard` now serves the UI the package ships.** In 1.70.0 it looked for the UI in the wrong folder and showed the "not built" page.
