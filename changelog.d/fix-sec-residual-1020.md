### Security

- **The Codex wrapper never moves or starts a file that hippo did not write.** Metadata at `~/.hippo/integrations/codex.json` that names any other path is logged and left alone, `hippo codex-run` refuses it and names the file, and a Codex update is no longer swapped back for the copy hippo saved.
- **The embeddings base URL and both rerankers share one outbound URL rule.** Each takes https, or http only to this machine, and refuses a URL with a user name or password in it.
- **Slack and GitHub webhook signatures are checked over the body bytes as sent.** A body that is not valid UTF-8 no longer verifies against a signature over its decoded text.
- **`POST /v1/sleep` refuses a request from a proxy or a page, even on this machine.** `POST /v1/auth/keys` refuses a member key before it reads the body.
- **A replayed Slack request is answered as a duplicate and not acted on.** Slack and GitHub each keep an in-memory window of the deliveries they took; it resets when the server restarts.
- **Failed and slow request log lines name the route template, not the path sent.** A memory id in a path no longer reaches the log.
- **An auth resolver's answer is refused past 1024 scopes or a scope past 256 characters.**
- **The delete core puts the tenant in its DELETE.** A caller that skipped its own reach check still cannot remove another tenant's memory.
- **`hippo serve` sends `Strict-Transport-Security` when it holds the TLS certificate itself.**

### Changed

- **3.0 break: the package runs no `postinstall` script, and `HIPPO_SKIP_POSTINSTALL` is gone.** The next routine `hippo` command re-applies an opted-in Codex wrapper. See `docs/UPGRADING-3.0.md`.
- **3.0 break: `POST /v1/sleep` answers 403 through a proxy on the same machine.** Call it on the machine itself. See `docs/UPGRADING-3.0.md`.
