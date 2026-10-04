### Fixed

- **A session's own notes folder is imported under the project it belongs to, not the folder the session ended in.** A session launched in the home folder that ended or compacted inside a repo or worktree imported the home notes again under that repo's name, so every project showed them twice. One store held 2,641 such copies. The notes now take the project of the folder the session started in, read from the transcript's first line, without a git call; home notes stay user-global. Notes from another repo, met inside a project store, go to the global store instead of being dropped.

### Changed

- **`hippo projects repair` now clears old damage in one reversible pass.** In the global store it sets aside every Claude Code note imported from a recorded session folder under the wrong project, edited since or not; anywhere, it sets aside an imported note under a project name when a user-global import holds the same text. It also folds an old name into the project its recorded folders resolve to today, so old worktree names join their repo without a merge command each. A name you merged into by hand is never folded back, and a fold into a name that itself folds waits for the next run. A dry run only reads, so it never blocks a hook. One backup, one audit event, and `hippo doctor` counts all three kinds. Names whose folders are all gone still need `hippo projects merge`.
