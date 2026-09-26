### Security

- **`GET /v1/audit?tenant=` for another tenant now needs an admin key.** A member-role key could read any tenant's audit log, including the host-wide `__host__` rows, by passing its name. It now gets a 403; reading its own tenant is unchanged.
- **Support-bundle redaction catches `BEARER` and `bearer` tokens in any case.** The strict redactor only matched `Bearer`, so an upper-case header in a log survived into `hippo support-bundle --include-logs`.
