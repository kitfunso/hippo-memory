### Security

- **BREAKING: the HTTP server and `hippo watch` start strict, and each default has one explicit opt-out.** `docs/UPGRADING-2.0.md` lists them all.
  - A keyless request from this machine is a member, so sleep and the quarantine routes answer 403. Opt out with `HIPPO_KEYLESS_LOCAL_ROLE=admin`.
  - A non-loopback bind without TLS refuses to start. Opt out with `--allow-cleartext` or `HIPPO_ALLOW_CLEARTEXT=1`.
  - `HIPPO_CLIENT_IP_HEADER` is read only from the peers in `HIPPO_TRUSTED_PROXIES`, and boot refuses the header with no proxy listed. `*` trusts every peer.
  - Each API key owner gets 20 requests a second, burst 40. Opt out with `HIPPO_CALLER_RPS=0`.
  - `hippo watch -- <cmd> [args]` and `runWatched(argv)` run with no shell, so no argument is read as shell syntax. `--shell` and `{ shell: true }` are the opt-in.
- **`hippo dashboard` keeps its token off a captured stdout.** When stdout is not a terminal, it prints the URL with no token and writes the full URL to `.hippo/dashboard.url` (mode 0600), replaced at each start.
