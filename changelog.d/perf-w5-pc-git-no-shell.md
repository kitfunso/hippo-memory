### Changed

- **The autolearn git check runs git directly instead of through a shell.** It saves one process start per repo checked, which on Windows is the slow part of `hippo init --scan`.
