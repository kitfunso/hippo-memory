### Security

- **Only an admin key can mint API keys.** A member key could call `POST /v1/auth/keys` and mint any key, an admin key included. Minting now needs an admin key; a member key gets 403.
- **A member key can revoke only itself.** `DELETE /v1/auth/keys/:keyId` let a member key revoke any key in its tenant, admin keys included. A member key now gets 403 for any key but its own; admin keys are unchanged.
- **The dashboard star button refuses cross-site posts.** The loopback Host check did not stop a page on another site, open in the same browser, from posting to the local dashboard. The star POST now returns 403 when `Sec-Fetch-Site` or `Origin` shows another site.

### Fixed

- **CLI writes land in the `HIPPO_TENANT` tenant.** `hippo trace record`, `hippo learn` and `hippo watch` wrote new memories to the default tenant whatever `HIPPO_TENANT` said, and `hippo supersede` put the replacement there too. Each now writes to the resolved tenant, and a replacement keeps the tenant of the memory it replaces.
- **`hippo audit` and `hippo export` stay in one tenant.** Both read every tenant's memories, so `audit --fix` could delete another tenant's rows. They now read only the tenant `HIPPO_TENANT` names, and `audit --fix` records why it removed each memory. The duplicate and schema-fit checks in `remember`, `learn` and `watch` are scoped the same way.
- **HTTP recall honours `mode`.** `GET /v1/memories?mode=hybrid` or `mode=physics` returned plain BM25 order. The route now ranks its candidates with the hybrid or physics scorer; `mode=bm25` and a missing `mode` keep BM25 order.
- **HTTP recall counts as a retrieval.** Memories returned over HTTP were never marked retrieved, so they decayed as if nobody had read them. They now gain strength the way CLI and MCP recalls do. `api.recall` stays a pure read, and neither path writes `last_retrieval_ids`.
