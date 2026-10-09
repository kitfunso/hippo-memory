### Changed

- **Internal:** `hippo embed` on a store with no backend now lists memory ids and reads the rows 64 at a time, for both the backfill and a model-change rebuild, instead of loading every memory; the rebuild still replaces the whole index in one transaction. Completing a card now promotes its unblocked children with one read and one update instead of up to four statements per child.
