### Changed

- **Z0 Codex runs set `memories.min_rollout_idle_hours = 1`.** Codex only turns a thread into memories after it has been idle that long, and the default of 6 hours meant almost no apply could feed a later one within a run. The same setting goes to X1 to X4.
