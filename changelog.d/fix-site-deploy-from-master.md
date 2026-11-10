### Changed

- **`npm run deploy` in `website/` now deploys only a clean checkout of the newest master.** It fetches `origin` first and stops with a fix line when the checkout has uncommitted changes or its HEAD is not `origin/master`. On 2026-11-10 the 3.5.1 site deploy ran from the release branch and replaced a print-style fix that had merged to master minutes before.
