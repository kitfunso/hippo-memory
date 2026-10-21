### Fixed

- **Failures that sleep, reranking and embedding used to swallow are now logged with their stack.** A skipped physics pass, a failed graph rebuild, a failed auto-sleep phase, a broken delivery recorder, an unreadable LLM reply and a CLEF outage each write one warn line with the error class, stack and cause. A client that hangs up mid-rerank no longer counts as a reranker outage, and its abort now stops the reranker post.
- **Two processes can no longer both break a dead embedding lock.** Only the waiter that creates the breaker file removes the stale lock, so exactly one writer takes the embedding index. Embedding writes now wait per hippo.db instead of across every store in the process.
- **Bad registry and eval baseline files give clear answers.** A workspace registry entry that is not a path is skipped with one warning, and an eval baseline with the wrong shape stops the run with the file path.

### Changed

- **`ConsolidationResult` gains `phaseFailures`**, the passes that failed and were skipped, each with its error fields. `scripts/check-caught-error-logs.mjs` now fails a catch that sends the error text only to a result array.
