### Changed

- **A CLI write that `hippo serve` refuses now exits 1 on Windows instead of crashing, and every typed object checks its required text with one rule.** `hippo remember`, `forget` and `promote` pick the server or the store once, through one write interface; a refused write used to end in a libuv abort code, and typed-object errors now drop the internal function name and refuse blank or over-cap text with the same words (see `docs/UPGRADING-3.0.md`).
