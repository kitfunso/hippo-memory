### Changed

- **Internal: no test asserts an upper bound on elapsed time any more.** Ten such bounds now assert what they stood for (the wait a process asked for, a pause count, a log line, a fake clock), a scan test keeps the count at zero, the supersede and Slack race tests run the production statements from two connections, the coverage provider's re-keying has unit tests, and seven token-eval test files join `npm test` while the publish workflow now requires the four slow ones.
