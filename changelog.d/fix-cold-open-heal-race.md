### Fixed

- **Opening a store while another process migrates it no longer fails with "no such column".** An open rebuilt missing tables without the write lock, so it could add an index to a table that another process had just made in an older shape. The rebuild now runs under the write lock.
