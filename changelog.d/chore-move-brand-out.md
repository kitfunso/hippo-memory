### Changed

- **The logo and site design rounds moved out of this repo.** `docs/brand` (341 MiB of renders) now lives in the private `kitfunso/hippo-brand` repo, so a clone of hippo is about 36 MiB of files instead of 377 MiB. Anthropic's plugin directory downloads the whole repo and refuses one over 256 MiB. A new CI check, `scripts/checks/check-repo-size.mjs`, fails a PR that takes the tracked files past 200 MiB.
