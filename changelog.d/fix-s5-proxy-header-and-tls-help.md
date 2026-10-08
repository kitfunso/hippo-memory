### Security

- **A loopback request that carries `Fly-Client-Ip` no longer gets the no-key local fallback.** The header means a proxy passed the request on, so the caller is not local. A request carrying it and no other proxy header was served without a key; it now gets 401, like one carrying `X-Forwarded-For`.
