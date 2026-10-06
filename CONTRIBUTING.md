# Contributing

Issues and pull requests are welcome. Run `npm test` before opening a PR (it skips the token-eval harness tests; run `npm run test:eval` when you change `scripts/token-eval/`), and see the Contributing section of the README for the open problems.

## Sign your commits (DCO)

Every commit needs a `Signed-off-by` line. Add it with `git commit -s`.

The sign-off certifies the [Developer Certificate of Origin](https://developercertificate.org/): you wrote the change, or otherwise have the right to submit it under this project's licence. There is no contributor licence agreement. Contributions come in under MIT and go out under MIT.

## What belongs here

This repository is the MIT core: everything an individual developer or a self-hosted team needs. Features for the commercial edition are out of scope here and will not be merged: SSO (OIDC and SAML sign-in), SCIM, the org admin view, the pilot report and telemetry join, SIEM export of the audit log, licence keys and the licence check, and hosted SaaS. See "Open source and commercial" in the README.

CI runs `scripts/check-open-core.mjs`, which fails a PR that adds files or identifiers matching those features under `src/`, `extensions/`, `integrations/`, `ui/` or `python/`. If it fires on something that is genuinely core (a word that only looks like one of those features), add a line `open-core: reviewed` to a commit message (or the PR description). The commit message is the safer place: a squash merge keeps commit messages, and the check runs again on the push to master.
