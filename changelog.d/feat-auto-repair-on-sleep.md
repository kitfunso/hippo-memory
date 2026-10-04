### Changed

- **`hippo sleep` runs the project tag repair once per store after an upgrade, so nobody has to.** It sets aside misfiled note imports, folds a project store's own folder name into its id and re-tags merged memories, writing a backup and an audit event first; a store with nothing to fix gets no backup. Name folds in the global store stay with `hippo projects repair --global`: their only evidence is compaction folders, which cannot see a same-named repo that never compacted. A failed repair warns and runs again at the next sleep.
