### Fixed

- **Sleep no longer re-sends the same failing work to the model every run.** A DAG summary whose rebuild kept failing went back to the model on every sleep, and a memory whose extraction found nothing was offered again each time. After 3 failed rebuilds in a row, sleep now waits a day before it tries that summary again. The wait doubles for each further failure, up to 7 days, and a provider outage does not count as a failure. Sleep also skips a memory whose extraction found nothing until its text changes or 30 days pass, so later memories are no longer starved when the first 20 have nothing to extract. That means the model returned an empty array, or every fact it returned was refused by a rejected value. A reply whose facts fail the quality check leaves the memory unmarked, so sleep tries it again. `hippo sleep` shows `N held` in the DAG rebuild line, and the sleep result gains `summariesRebuildHeld` and `extractionHeld`. There is no migration.

### Changed

- **A store built on `hippo-memory/store-kit` may add three optional `consolidation` members.** They are `noteRebuildFailures`, `emptyExtractions` and `noteEmptyExtractions`. Such a store may also honour the new optional `at` argument of `dirtySummaries`. A store without them behaves as before.
