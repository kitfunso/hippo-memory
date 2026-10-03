### Changed

- **The Slack and GitHub webhook receivers now live beside their connectors.** `handleRequest` in `src/server.ts` calls `handleSlackEventsWebhook` (`src/connectors/slack/webhook.ts`) and `handleGitHubEventsWebhook` (`src/connectors/github/webhook.ts`); shared HTTP helpers moved to `src/http-util.ts`. Status codes, signature checks, DLQ writes and audit rows are unchanged.
