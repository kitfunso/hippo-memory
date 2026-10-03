### Changed

- **`hippo sleep` finds conflicts and merge clusters through an inverted index instead of comparing every pair.** Each memory is tokenized once per pass, and only pairs that share enough rare tokens to reach the threshold are compared, so the work follows how many memories actually overlap rather than the square of the store size. The conflicts and merges found are unchanged, pinned by a seeded property test against the old pairwise passes.
