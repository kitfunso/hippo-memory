### Changed

- **`hippo serve` keeps `server.key` out of git and, on Windows, away from other accounts.** `.hippo/.gitignore` lists `server.key`, and the key file is limited to the current user with `icacls`. Dependabot runs npm updates weekly, with up to 10 open pull requests per directory.
- **On Windows, `icacls` runs from `%SystemRoot%\System32`.** Windows searches the working folder before PATH for a bare name, so an `icacls.exe` in a repo could have run in its place. `.hippo/.gitignore` also gains `server.key` when a later `!` rule or a leading space would leave the key unignored.
- **`hippo serve` limits each new `server.key` to the current user while the file is still empty, then writes the key and renames the file into place, so an old file's grants or a hard link never hold the key.**
