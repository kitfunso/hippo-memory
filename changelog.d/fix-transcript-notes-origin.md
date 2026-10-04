### Fixed

- **A session's own notes folder is imported under the project it belongs to, not the folder the session ended in.** A session launched in the home folder that ended or compacted inside a repo or worktree imported the home notes again under that repo's name, so every project showed them twice. One store held 2,600 such copies. The notes now take the project of the folder Claude Code filed them under, found without a git call; home notes stay user-global.

### Changed

- **`hippo projects repair` now clears old damage in one reversible pass.** It sets aside imported notes under a project name when a user-global import holds the same text, and, in the global store, folds an old name into the project its recorded folders resolve to today, so old worktree names join their repo without a merge command each. A name you merged into by hand is never folded back. One backup, one audit event, and `hippo doctor` counts all three kinds. Names whose folders are all gone still need `hippo projects merge`.
