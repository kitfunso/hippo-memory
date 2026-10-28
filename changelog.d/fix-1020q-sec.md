### Changed

- **`hippo serve` keeps `server.key` out of git and, on Windows, away from other accounts.** `.hippo/.gitignore` lists `server.key`, and the key file is limited to the current user with `icacls`. Dependabot runs npm updates weekly, with up to 10 open pull requests per directory.
- **On Windows, hippo starts `git`, `icacls`, `schtasks`, `taskkill` and `cmd.exe` from PATH only.** Windows searches the working folder before PATH for a bare name, so a program file of the same name in a repo could run instead. A tool missing from PATH now fails to start with ENOENT. `.hippo/.gitignore` also gains `server.key` when a later `!` rule or a leading space would leave the key unignored.
