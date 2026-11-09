### Fixed

- **A write sent to a running hippo server that may have landed now says so, whatever the error.** Before, an unreadable reply or an error hippo did not recognise was reported as "the server refused", with no warning that the write may already have been applied. The CLI now never replays such a write locally and tells you it may already have been applied. The advice to check with `hippo recall` is gone, because recall cannot show the result of forget, archive or promote.
- **A session-end worker that gives up with a request still queued now writes one line to the session log.** After five rounds in which it could not take the queued request it stopped without a word, and a detached worker's warnings reach nobody. `hippo last-sleep` shows the new line at the next session start.
