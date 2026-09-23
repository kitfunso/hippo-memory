### Fixed

- **Sleep no longer gets stuck on a decayed raw memory.** A `kind='raw'` row (a Slack or GitHub message kept word for word) decays like any other row. Once its strength fell under the 0.05 floor, the consolidate pass tried to delete it, the append-only trigger on raw rows refused, and the whole batch rolled back with `raw is append-only`. The row never recovered, so every later sleep failed the same way and nothing else decayed, merged or got written. A short raw row the junk audit flagged broke `sleep` the same way. The decay pass, dedup and the junk audit now share one rule, `canAutoDelete`: pinned and raw rows are never deleted automatically. Raw rows still leave only through `archiveRawMemory`.
- **Sleep no longer deletes pinned memories.** The junk audit removed a pinned row whose text was too short, and dedup removed a pinned copy when an unpinned twin scored higher. Both now keep it. A pinned or raw row the audit would have removed is reported as a warning, marked `(pinned, kept)` or `(raw, kept)`.
- **A memory pinned, forgotten or superseded while sleep runs keeps that change.** Sleep loads every row, waits on the LLM phases, then writes its results in one batch. A pin, `forget` or `supersede` that landed in between was overwritten by the stale copy: the pin was lost, the forgotten row came back, and the superseded row became current again. The batch now re-reads each row's pin, kind and supersession before writing it, skips a row that was deleted in the meantime, and never deletes a row that was pinned in the meantime.
- **`sleep --dry-run` previews every delete.** It stopped after the consolidate pass, so the preview left out dedup and the junk audit, the two phases that delete the most. The dry run now runs both without deleting and reports what they would remove, then stops before share and ambient. The CLI prints "Would dedupe" and "would remove" instead of "Deduped" and "removed", and `POST /v1/sleep` with `dry_run: true` now returns `deduped` and `audit` when there is something to report.
- **MCP auto-sleep counts what arrived since the last sleep.** It counted the tenant's memories created in the last 24 hours, so once a busy day passed the threshold (50 by default) every later `remember` started another sleep, and several could run at once. It now counts rows created since the last sleep, looking back at most 24 hours, and runs one sleep per store at a time. The count is one indexed query instead of loading every row.
- **`remember` honours `defaultHalfLifeDays`.** `hippo remember` and the `remember` API, which the MCP server and `POST /v1/memories` also go through, always used 7 days. Capture, import and the other internal writers keep the 7-day default.

### Security

- **`extraction.enabled: false` turns off every LLM call in sleep.** Consolidate never read the setting: extraction, DAG summaries, summary rebuilds and entity profiles all ran whenever `ANTHROPIC_API_KEY` was set. Now the setting is the off switch for all four.
- **Secrets are masked before memory text goes to the LLM.** The extraction and DAG summary prompts sent memory text to Anthropic as it was stored. Both now pass it through `redactSecrets` first, so a key, token or password saved in a memory is masked before it leaves the machine.
- **LLM failures during sleep are reported.** An HTTP error, a network failure or an unreadable reply was swallowed, so a bad or expired key made every sleep skip extraction and summaries with no sign of it. Each phase now adds one line per distinct error to the sleep details and logs it to stderr, and `hippo remember --extract` prints why extraction failed.

### Changed

- **Automatic deletes say who and why.** Dedup and the sleep junk audit log each delete as a `forget` audit row with the caller as actor and a `metadata.reason` (`dedup: duplicate of <id>`, `sleep-audit: <reason>`). They used to log as `cli` with no reason.

### Internal

- **Tests never reach a real LLM or embedding API.** `vitest.config.ts` clears the Anthropic, OpenAI, Voyage, Cohere, TypeSafe and LLM-reranker keys for the main process and every worker, so a developer's own keys can no longer bill or leak prompts from a test run.
