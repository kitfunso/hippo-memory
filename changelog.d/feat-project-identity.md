### Added

- **A project is named by its committed `.hippo-project.json` id, else its `origin` remote, else its folder.** Two repos both called `api` shared every memory in the global store; now each gets its own id, such as `github.com/acme/api`. The remote is read from git's config files with no git process, so hooks stay fast; ssh, scp, https and Azure DevOps forms of one repo agree, and a token in the URL, query or fragment never reaches a row. A file id may not contain a slash, so a cloned repo's file cannot claim another repo's remote id. A worktree takes its main checkout's remote, a submodule its own, a nested store its folder name, and home stays user-global. Set `projectIdentity.remote` to `false` in the global config to keep folder names.
- **Rows saved under the old folder name stay visible.** Context, recall, the ambient summary, compaction repeats and churn staleness read rows under every name the checkout resolves to: the file id, the remote and the old folder name. The next agent-memory sync moves imports and their dormant copies under the id in place, keeping their ids, instead of importing them again.

### Changed

- **`hippo projects repair` folds a project store's own folder name into its id, and refuses a name two projects now claim.** `hippo doctor` names each fold and each shared name with its ids; a shared name needs `hippo projects merge` by hand. `hippo projects merge` now sets aside only the imports the target already holds; the next sync moves the rest under the target.
