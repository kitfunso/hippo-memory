### Fixed

- **`hippo init` on Windows creates the daily runner task again, and it no longer opens a terminal window at 6:15.** Since 0.24.2 the `schtasks` call went through `cmd.exe`, which split the command at its `&&`, so every Windows init fell back to printing instructions. hippo now passes the arguments straight to `schtasks` and runs the task under `conhost.exe --headless`, so the morning run has no visible console. An existing `hippo-daily-runner` task is left as it is.
