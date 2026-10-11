### Changed

- **Tests assert behaviour, not source text or sleeps.** The bearer lockdown test now sends a credential-less request to every row of the live route table, the curate CLI test runs `hippo reject` and `hippo invalidate` against a temp store, and fixed sleeps in eight tests became polls on a shared `waitFor` helper.
