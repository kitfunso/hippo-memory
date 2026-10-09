### Fixed

- **A Google API key, Slack token or `sk`-prefixed key that ends in a hyphen is redacted whole.** A Google key ending in `-` was not redacted at all. A Slack token or `sk`-prefixed key was redacted up to its last letter or digit, and its closing hyphens stayed in the text beside `[REDACTED]`.
- **Recall order no longer depends on arrival order when a score is infinite or not a number.** Two memories that both scored `Infinity`, or any memory with a `NaN` score, came back in the order the search happened to produce them. Equal scores now go to the id tie-break whatever their value, and a `NaN` score ranks last.
- **An id with too many digits to be held exactly is refused.** A command given an id past 2^53 used to act on the neighbouring id the number rounded to. It now prints the same `Invalid ... id` error as any other bad id and exits 1.
- **The sharing scrub masks a home path that directly follows another.** `/home/kit/home/kit` came out as `[home]/home/kit`, with the user name still in it, and scrubbing that text again changed it. Each glued home path now gets its own `[home]`, and a second scrub changes nothing.

### Changed

- **Secret scrubbing, injection screening, the id, cursor and argv parsers, recall ordering and the store error codec are now also tested on generated inputs.** `tests/_helpers/property.ts` draws them from fixed seeds and reports the smallest failing input. The tests are internal; the four gaps they found are listed under Fixed.
