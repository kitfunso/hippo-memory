### Fixed

- **A new Codex launcher now points at a file that exists.** Since 1.61.0, `hippo hook install codex` and `hippo setup` wrote a launcher that named a missing file, so `codex` did not start. An upgrade also stopped repairing an installed launcher.
- **`hippo dashboard` now serves the UI the package ships.** In 1.70.0 it looked for the UI in the wrong folder and showed the "not built" page.
