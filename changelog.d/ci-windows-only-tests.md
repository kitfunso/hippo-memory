### Internal

- **CI runs the Windows-only tests on Windows.** Every CI job ran on Linux, so tests that skip off Windows had only ever run on a developer's machine, among them the support bundle's drive-mount and one-folder-home tests behind the 1.52.6 fix. A new `windows` job builds on `windows-latest` and runs every test file that names `win32`, so a new Windows test is picked up without editing the workflow.
