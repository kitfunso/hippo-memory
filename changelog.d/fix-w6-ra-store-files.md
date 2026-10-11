### Fixed

- **Legacy store files:** an `index.json` or `stats.json` holding `null`, an array or a string no longer makes every open fail; it reads as empty with a warning. A bad legacy markdown file is skipped with a warning.
- **Index mirror:** `index.json` is rewritten in place like `stats.json`.
- **Internal:** package.json scripts from git history must be an object of strings, and a rejected body cancel between HTTP retries no longer loses the retry.
