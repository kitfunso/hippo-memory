### Security

- **Every stored text column, mirror file and full-text index now holds secret-shaped text redacted.** Older rows are redacted at their next write; see `docs/UPGRADING-3.0.md`.
