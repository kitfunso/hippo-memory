### Fixed

- **A bad `HIPPO_V1_RPS` now stops `hippo serve` at boot, and a wrong-typed body field gets a 400.** Before, a non-numeric `HIPPO_V1_RPS` silently turned the /v1 and /mcp limiter off (only an explicit 0 does now), and `{"scope":123}` on `POST /v1/memories` was stored with the default scope. On Windows, a bare command name is looked up on PATH only, never in the working folder, and an argument holding a line break is refused before it reaches cmd.exe. The Codex launcher is repaired only by the hippo CLI that `hippo hook install codex` recorded.
