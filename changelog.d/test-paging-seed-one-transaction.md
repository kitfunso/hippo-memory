### Fixed

- **The list-paging test no longer times out on Windows.** It seeds its 1003 rows in one transaction without markdown mirrors, since it reads rows only. The boundary case dropped from about 6 s to 0.3 s.
