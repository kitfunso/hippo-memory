### Fixed

- **`hippo init` on Windows:** the `schtasks /create` line printed when the task cannot be created now doubles a backslash that sits before a quote or at the end, so the pasted command keeps its `/tr` value in one argument.
