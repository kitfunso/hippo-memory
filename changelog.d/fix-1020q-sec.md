### Changed

- **`hippo serve` keeps `server.key` out of git and, on Windows, away from other accounts.** `.hippo/.gitignore` lists `server.key`, and the key file is limited to the current user with `icacls`. Dependabot runs npm updates weekly, with up to 10 open pull requests per directory.
