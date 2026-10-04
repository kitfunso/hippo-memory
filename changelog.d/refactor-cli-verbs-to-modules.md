### Changed

- **`recall`, `explain`, `context`, `card` and `eval` live in their own modules under `src/cli/`.** The command table loads each one only when that verb runs. Output, flags and exit codes are unchanged, pinned by the recall golden and by new in-process goldens for `context`, `card` and `eval`. The long `recall`, `context`, `card` and `eval` bodies are split into parse, run and render steps, so no function in these verbs is over 200 lines.
