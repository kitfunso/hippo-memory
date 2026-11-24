### Changed

- **A `latest` release now sends a `core-release` dispatch to a downstream CI.** The `release-dispatch` job in `npm-publish.yml` posts it after publish, from a `release-dispatch` environment limited to `v*.*.*` tags, and skips when its repo or token secret is unset. A failed dispatch never marks the release red.
