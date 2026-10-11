### Fixed

- **Z0 task commands now find a repository's own scripts, such as `gradlew.bat`, whichever shell launched the runner.** Claude Code sets `NoDefaultCurrentDirectoryInExePath` in its own shells, so cmd.exe stopped looking in the checkout, and every Metrolist test failed at both base and fix. The runner now drops that variable with the other parent-session keys.
