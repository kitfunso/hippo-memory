### Fixed

- **Integer CLI flags now refuse a value that is not all digits.** `--limit 12abc` and `--limit " 12"` used to read as 12; they now take the same path as any other non-number.
