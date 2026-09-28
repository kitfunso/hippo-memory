### Fixed

- **A release now replaces its own prerelease on `latest`.** `scripts/publish-dist-tag.mjs` compared only major.minor.patch, so if a prerelease such as `2.0.0-rc.1` ever sat on `latest`, publishing `2.0.0` went to `maint-2.0` and left the rc as the default install. The workflow sends prereleases to `next` and none has been published, so this could only follow a hand publish.
