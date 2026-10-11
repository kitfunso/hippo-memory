### Fixed

- **A throttled caller can no longer reset its rate limit by rotating addresses.** When the limiter's table is full, a bucket is dropped only once it has refilled; until then new addresses share one bucket. The GitHub webhook also refuses a malformed signature header before it reads the body.
- **Smaller hardening.** The daily-runner install calls schtasks and crontab with no shell, savepoint names must be plain identifiers, `graph view --open` on Windows will not hand cmd.exe a file name holding `&` or `%`, the dashboard cookie expires after a day, a failed postinstall prints its reason, and the `HIPPO_TRUSTED_PROXIES=*` warning names the risk.
