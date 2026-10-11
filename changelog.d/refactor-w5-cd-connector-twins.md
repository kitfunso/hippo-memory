### Changed
- **Internal:** GitHub and Slack now share one event-log vocabulary (`githubEventRecord`/`slackEventRecord` both answer `{ seen }`, `markGitHubEventSeen`, `markGitHubDlqRetried`), one DLQ replay (`replayParked`) and one `rememberWithEventLog`; each connector injects only its signature check, envelope guard and re-ingest.
