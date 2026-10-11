### Fixed

- The dashboard no longer writes its access token into the log. A failing `/api/` request that carried `?token=` now logs the path without its query string.
