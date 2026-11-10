### Fixed

- **A write sent to a running hippo server that may have landed now says so, whatever the error.** Before, an unreadable reply or an error hippo did not recognise was reported as "the server refused", with no warning that the write may already have been applied. The CLI now never replays such a write locally. It tells you the write may already have been applied and to check with `hippo recall` before you run it again.
- **A session-end worker that gives up with a request still queued now writes one line to the session log.** After five rounds in which it could not take the queued request it stopped without a word, and a detached worker's warnings reach nobody. `hippo last-sleep` shows the new line at the next session start.
