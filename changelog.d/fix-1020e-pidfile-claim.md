### Fixed

- **A hippo command run while `hippo serve` is starting no longer deletes the server's pidfile claim.** `serve()` creates `server.pid` empty for an instant before it fills the file in. `detectServer` read that empty file as corrupt and removed it, which freed the store's one-server lock for a second server. It now leaves a claim under 5 seconds old alone.
