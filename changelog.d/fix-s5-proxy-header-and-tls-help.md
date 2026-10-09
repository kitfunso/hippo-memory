### Security

- **A loopback request that carries `Fly-Client-Ip` no longer gets the no-key local fallback.** The header means a proxy passed the request on, so the caller is not local. A request carrying it and no other proxy header was served without a key; it now gets 401, like one carrying `X-Forwarded-For`.
- **`hippo serve` warns at start when `HIPPO_CLIENT_IP_HEADER` is set and `HIPPO_TRUSTED_PROXIES` is not.** In that setup any caller that reaches the port without passing the proxy can send the header and pick its own rate-limit bucket. The header is still read as before; the line names the risk and the variable that pins the header to the proxy.

### Documentation

- **`hippo serve --help` lists `--tls-cert` and `--tls-key`.** The flags worked but the help text did not name them or their `HIPPO_TLS_CERT` and `HIPPO_TLS_KEY` variables.
