### Security

- The daily-runner installer now refuses a store path that holds `%`, which crontab reads as a newline and would split the installed line.
- The LLM and Jev rerankers now read the model reply through the same 1 MB cap as the CLEF reranker, so a hostile endpoint cannot make recall buffer an unbounded body.
- Embedding provider replies are now read under a size cap that scales with the batch, and an error body is read for its first 1,200 bytes only.
