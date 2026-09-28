### Fixed

- **Closing a session on Windows no longer pops up terminal windows.** The session-end worker runs detached, so on Windows it has no console, and every `git` call it made (the handoff's git state, `learn --git` during sleep) opened a new visible terminal window. Closing several sessions at once gave a stream of them for minutes. Every child process hippo starts now sets `windowsHide`, and a test fails if a new one leaves it out.
