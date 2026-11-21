### Added

- **Send the LLM passes to your own OpenAI-compatible endpoint.** Set `HIPPO_LLM_BASE_URL` and `HIPPO_LLM_MODEL` (and `HIPPO_LLM_API_KEY` if the endpoint needs one) and sleep, `hippo refine`, local remember extraction and follow-up rules call that endpoint and never Anthropic. Plain http to a private host needs `HIPPO_LLM_ALLOW_HTTP=1`, and a half-set or unsafe setting is refused with a reason instead of falling back to Anthropic. `llmRoute()` reports which route a process takes.

### Security

- **Model reply text no longer reaches logs, events or errors.** A reply that is not JSON used to put V8's parse error, which quotes the reply, into the failure message and the log line. Both the Anthropic and the endpoint adapters now report a fixed text.
- **A key that cannot be a header is refused without echo.** `ANTHROPIC_API_KEY` and `HIPPO_LLM_API_KEY` with a space, a newline or another character a header cannot carry give a named refusal. The value is never quoted. `ANTHROPIC_API_KEY` is now trimmed, so a key file's trailing newline keeps working.
