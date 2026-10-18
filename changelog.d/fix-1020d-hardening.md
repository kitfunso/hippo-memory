### Fixed

- **An unreadable `config.json` stops the load instead of running on the defaults.** When the file's folder denies access (`EACCES` or `EPERM`), hippo now throws an error that names the path and the code and says to fix the permissions, as it already did for a file that will not parse. A missing file still means the defaults.
- **`hippo init` installs the daily-runner crontab for a user who has none.** `crontab -l` exits 1 with "no crontab for <user>" in that case, and hippo treated it as a failure and only printed the line to add by hand. Any other crontab failure still prints that line, and now also logs why.
