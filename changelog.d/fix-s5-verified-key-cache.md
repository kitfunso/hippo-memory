### Security

- **A bearer API key now runs scrypt once per minute, not once per request.** The server keeps an in-process cache of verified keys (SHA-256 of the token, never the token; 1,000 keys, 60 s TTL). A revoke or scope change made in the server process applies on the next request; one made by another process, such as `hippo auth revoke`, applies within 60 s.
- **Malformed tokens and unknown or revoked key ids are rejected without scrypt.** The old miss path ran a dummy scrypt to hide whether a key id exists. Key ids are 120 random bits and appear in audit logs, so that hid nothing, and it let a few clients sending junk `hk_` tokens inside the rate limit stall the event loop. A wrong secret on a real key id still pays scrypt and is never cached.
