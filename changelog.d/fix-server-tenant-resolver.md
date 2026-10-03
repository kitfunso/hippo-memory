### Fixed

- **Webhook rows no longer land under an empty tenant.** Five places in the server read `HIPPO_TENANT` directly, so an empty or whitespace value wrote Slack and GitHub dead-letter rows under tenant `''`. They now use `resolveTenantId`, which falls back to `default`.
