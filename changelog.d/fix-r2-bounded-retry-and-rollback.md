### Fixed

- The GitHub backfill stops after 5 rate-limit retries or 10 minutes of waiting and fails with the reset time, instead of waiting without limit.
- **Internal:** a failed ROLLBACK in a write scope is logged at error and no longer hides the original error.
- Bad JSON in a ChatGPT or Claude import file, a malformed Codex history line and an unreadable server pidfile now log a warning before the fallback.
