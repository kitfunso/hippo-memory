### Added

- **Z0 records name the hippo build, and `--pins FILE` holds a chunked run to one build.** Every record carries the runner checkout's commit, whether its tree differs from that commit, and a hash of `dist/`. With `--pins`, a run refuses to start when the Claude Code or Codex version, either model, the hippo commit or the `dist/` hash differs from the file, or when the checkout has changes beyond its commit.

### Changed

- **Z0 records what each Claude Code session sent the model.** The runner routes every Claude Code attempt through a local proxy that logs request bodies (never headers) to the run's raw directory. The read check voids a session when a request carries an operator canary, auto memory in A0 or A4, or hippo text outside A2, A5 and X2 (prereg G1).
- **Z0 Codex runs turn plugins and apps off.** A ChatGPT login otherwise pulls an account-dependent plugin set into each fresh `CODEX_HOME`. The same setting goes to X1 to X4.
- **Z0 Codex runs turn Codex memories off by default, with no wait after each session.** Codex makes memories only from interactive threads, never from `codex exec` ones, so X1 to X4 run without them (prereg 91, smoke report point 5).

### Fixed

- **Z0 finds Codex hook output in a real rollout.** Codex 0.153.4 tags it in the message's metadata (`hooks.additional_context`). The reader looked for a field only the fake Codex wrote, so a Codex apply's chain read `shown: false` even when hippo's hook carried the lesson.
- **Z0's read check no longer voids a session for a file the agent wrote with a heredoc.** A heredoc body that only `cat` or `tee` takes is file content; one fed to another command, or piped on, still counts.
