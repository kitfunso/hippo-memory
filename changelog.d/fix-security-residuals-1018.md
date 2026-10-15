### Security

- **New API key hashes carry their scrypt cost.** Keys minted from now on are stored as `scrypt2$<N>$<r>$<p>$<salt>$<hash>` (same cost as before: N=16384, r=8, p=1); existing `scrypt$<salt>$<hash>` rows still verify, and a stored cost above N=2^20, r=32 or p=16 is refused before any scrypt runs. Integrators who read `api_keys.key_hash` will see the new prefix. The dead-letter queue statements also refuse any table or column name that is not a known identifier, and a failed Codex wrapper repair at install now logs a warning.
