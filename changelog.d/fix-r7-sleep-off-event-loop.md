### Fixed

- **`hippo serve` keeps answering while `POST /v1/sleep` runs.** The route ran the whole consolidation inside the serving process, so every other request, `GET /health` included, waited until the sleep was over. The sleep now runs in a child process and the route waits for its answer; the response body, the status codes and the busy `503` are unchanged. A sleep that has not finished after 10 minutes (or `HIPPO_SLEEP_TIMEOUT_MS`) is stopped and answered with `504`; the next sleep carries on from where it stopped.
