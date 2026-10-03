### Security

- **A proxied request no longer gets keyless admin on `hippo serve`.** The server let any loopback caller in as admin without an API key. A reverse proxy on the same host (nginx, Caddy, cloudflared, a dev tunnel) connects from 127.0.0.1, so every outside request it forwarded got admin too. A keyless loopback request that carries `Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto`, `X-Real-IP`, `Cf-Connecting-Ip` (Cloudflare Tunnel) or `True-Client-Ip` now gets the same 401 as any keyless remote request, and the server logs one `warn` line with the request id and the fix.

### Changed

- **Behind a proxy, send an API key.** Mint one with `hippo auth create` and send it as `Authorization: Bearer hk_...`. A direct local caller with none of those headers (the CLI, the SDKs, a local script) keeps the keyless fallback, and a request with a valid key is served as before.
