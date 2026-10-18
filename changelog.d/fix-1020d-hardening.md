### Fixed

- **An unreadable `config.json` stops the load instead of running on the defaults.** When the file's folder denies access (`EACCES` or `EPERM`), hippo now throws an error that names the path and the code and says to fix the permissions, as it already did for a file that will not parse. A missing file still means the defaults.
