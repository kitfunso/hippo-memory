### Changed

- **The per-prompt hook now injects memories that match your prompt, not the five newest.** `pinnedInject.promptRecall` defaults to true. Each prompt gets your pinned memories plus up to 5 that share words with it, and only the pinned ones when nothing matches. A prompt-less payload still gets the five newest. The Z1 replay (`docs/evals/2026-09-26-z1-prompt-recall-result.md`) cut median injected tokens from 847 to 533, with its primary overlap score tied at 0.0545. It also had costs: the mean fell only from 684 to 662, the p90 rose from 1,438 to 1,600 because the matched block is never skipped as unchanged, and session-lifetime overlap fell from 0.086 to 0.067. Hook p95 at 10,000 memories is about 210 to 230 ms since 1.52.1, against about 210 ms for the old hook. A lesson saved earlier in the session no longer rides along on every prompt; it appears when a prompt touches it. This default carries no task-benefit claim. Set `{"pinnedInject":{"promptRecall":false}}` in `.hippo/config.json` for the old newest-5 behaviour.

### Fixed

- **A session digest no longer copies an older digest that prompt recall injected.** The echo filter checked only the five newest digests, which was all the old hook could inject. It now checks every live digest from other sessions.
