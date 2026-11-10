### Changed

- **A blank `superseded_by` link now reads as live again, and storage keeps one spelling of "no successor".** The store schema is now v63: opening a store sets `memories.superseded_by` to NULL wherever it was the empty string (a row with an unknown kind is left alone so the open cannot fail), and every row write stores NULL for an empty link. A memory with a blank link was hidden from recall and could be deleted or set aside by `hippo sleep`; after the first open it is returned and kept. The migration is one-way and touches no other column.
