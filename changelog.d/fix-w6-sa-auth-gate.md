### Fixed

- **One auth gate runs before every /v1 handler.** Each row of the /v1 route table now declares its auth need (`caller`, `admin`, `host-admin-local` or `webhook-signature`), and dispatch enforces it before the handler runs. A request with a missing or bad key now gets 401 before any parameter check, where a few list routes used to answer 400 first. The Slack and GitHub webhooks are table rows that skip the key check because their signature check is the proof.
- **The MCP client key uses the real client address behind a trusted proxy.** `POST /mcp` now keys per-client state on the same address the rate limiter uses, so both agree when `HIPPO_TRUSTED_PROXIES` lists the proxy. A forwarded header from an untrusted peer is still ignored.
- **The GitHub webhook refuses a replayed delivery.** A signed delivery whose `X-GitHub-Delivery` id was seen in the last 24 hours gets 409. A delivery that failed releases its id, so GitHub's redelivery still gets through.
- **Internal:** `PUBLIC_ROUTES` and the exported `subscriberKey` are gone; tests read the public rows off `V1_ROUTES` and test subscriber keys through `clientLimitKey`.
