### Changed

- **Fact extraction, DAG summaries and `hippo refine` now send their Anthropic Messages requests through one client in `src/util/anthropic-messages.ts`.** Request bytes, results and failure messages are unchanged. Internal only.
