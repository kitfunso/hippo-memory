### Security

- **The dashboard URL opens the dashboard once, within 10 minutes.** `dashboard.url` now holds a one-time ticket in place of the per-start access token, so a URL left in browser history or a copied file opens nothing. Run `hippo dashboard` again for a fresh URL; the session cookie the ticket sets lasts a day, as before.
- **`isCrossSite` on `hippo-memory/server` compares the scheme too.** An `http://` page no longer passes for an `https` listener on the same host and port.
- **The `hippo graph` page carries a Content-Security-Policy.** It runs only its own script and style block, each named by hash, and loads nothing else.

### Changed

- **The per-address rate limiter frees a slot at its key cap without a walk of every bucket.** It keeps the same eviction order: the oldest refilled bucket, then the oldest that can still spend, then the oldest.
