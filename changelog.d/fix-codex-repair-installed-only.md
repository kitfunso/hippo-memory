### Fixed

- **A source checkout of hippo no longer rewrites your Codex launcher.** If you opted in with `hippo hook install codex`, hippo repairs the wrapper after a Codex update overwrites it, and the repaired wrapper runs the copy of hippo that did the repair. `npm install` or a CLI command inside a clone of this repository could therefore point your `codex` command at the clone, and `codex` broke when the clone was deleted. The repair now runs only from a copy a package manager installed. `hippo hook install codex` works from any copy, as before.
