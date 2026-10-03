### Fixed

- **The Codex wrapper starts Codex again on Windows when Codex is installed through npm.** The wrapper launched the real `codex.hippo-real.cmd` through cmd.exe with its command line quoted twice, so `codex` failed with "is not recognized as an internal or external command" and never started. Arguments with spaces, quotes, `&` or an empty string now reach Codex unchanged.
