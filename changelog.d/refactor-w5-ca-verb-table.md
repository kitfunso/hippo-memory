### Changed

- **`hippo recall --help` now lists `--include-superseded`, `--as-of <iso-date>` and `--multihop`.** recall already read all three; its help left them out.
- **Internal:** each CLI verb is one row in `src/cli/verbs/`: its handler, flags, help text and place in `hippo help` come from that row, and `--dry-run` support follows the flags it declares. A test now fails when a verb's help leaves out a flag it declares or names one it does not read; the flags still missing from help are listed in that test and may only shrink.
