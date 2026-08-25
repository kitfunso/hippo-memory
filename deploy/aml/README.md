# AML evaluation deployment

Public Add/Search endpoint for the [Agent Memory Leaderboard](https://agentmemories.ai)
(open-source methods category), live at **https://aml.hippo-memory.com**.

Host: a self-managed machine running the Docker image below, published to the
internet through a named Cloudflare Tunnel. No inbound ports are open on the
host; the tunnel makes outbound connections to Cloudflare's edge, and the
container's port is bound to 127.0.0.1 only.

## What AML calls

The public endpoints are served by `adapter/adapter.mjs`, a zero-dependency
Node proxy that translates AML's contract (agentmemories.ai/api-guide, read
2026-08-25) onto hippo's native API:

| AML operation | public route | behind it |
|---|---|---|
| Add | `POST /add` | one hippo memory per chunk: messages joined as a role-prefixed transcript, `scope: aml/<user_id>`, tagged `aml-session:<session_id>` |
| Search | `POST /search` | `GET /v1/memories?q&limit=top_k&scope=aml/<user_id>`, results mapped to `{data:[{id, content, score}]}` |
| Health | `GET /health` | mirrors hippo's health, unauthenticated |

Per-user isolation rides on hippo's shipped scope machinery: scoped recall is
an exact-match filter, so no user's rows (and no unscoped row) can appear in
another user's results. The adapter accepts `Bearer`, `Token`, or `X-Api-Key`
credentials and forwards them verbatim to hippo, which validates against a
store-resident API key (scrypt-hashed at rest). The adapter holds no secrets.
It also forwards Cloudflare's `cf-connecting-ip` so hippo's rate limiter keys
per real client.

## Configuration facts that matter for reproduction

- **Embeddings: the local default** (`@huggingface/transformers`), no API key.
  The deployment benchmarks hippo as installed, not a hosted-embedder variant.
  A frontier-embedder configuration would be a separate, separately-labeled
  leaderboard entry per AML's versioned-contract rules.
- **Store root layout**: the root IS the `.hippo` directory (`/data/.hippo` on
  the volume). The entrypoint runs `hippo init` on first boot only.
- **`HIPPO_REQUIRE_AUTH=1`** (baked into the image): binds non-loopback and
  forces every request through Bearer validation.
- **`HIPPO_CLIENT_IP_HEADER=cf-connecting-ip`**: Cloudflare stamps the real
  client address in this header, so the /v1 rate limiter keys per client
  instead of collapsing every request into the tunnel's single source address.
  Set it only behind a proxy that overwrites the header on every request.

## Standing it up

```sh
# 1. Build and start both containers (from the repo root). Only the adapter
#    is published, loopback-only, on 127.0.0.1:18081.
docker compose -f deploy/aml/docker-compose.yml up -d --build

# 2. Cloudflare Tunnel (one-time): authorize the zone, create, route
cloudflared tunnel login
cloudflared tunnel create hippo-aml
cloudflared tunnel route dns hippo-aml aml.hippo-memory.com

# 3. ~/.cloudflared/config.yml
#    tunnel: <tunnel id>
#    credentials-file: <path printed by tunnel create>
#    ingress:
#      - hostname: aml.hippo-memory.com
#        service: http://localhost:18081
#      - service: http_status:404

# 4. Run it (or install persistence: `cloudflared service install` from an
#    admin shell, or a user Startup entry running `cloudflared tunnel run hippo-aml`)
cloudflared tunnel run hippo-aml
```

## Operating it

```sh
# mint the evaluation key (shown ONCE; hippo stores only a scrypt hash)
docker exec -w /data hippo-aml node /app/dist/src/cli.js auth create --label aml-eval --role member --json

# revoke a key
docker exec -w /data hippo-aml node /app/dist/src/cli.js auth revoke <keyId>

# smoke-check from outside (AML contract)
curl https://aml.hippo-memory.com/health
curl -X POST https://aml.hippo-memory.com/add -H "Authorization: Bearer <key>"   -H "Content-Type: application/json"   -d '{"request_id":"r1","messages":[{"role":"user","content":"hi"}],"user_id":"u1","session_id":"s1"}'
curl -X POST https://aml.hippo-memory.com/search -H "Authorization: Bearer <key>"   -H "Content-Type: application/json"   -d '{"query":"hi","user_id":"u1","top_k":5}'
```

Operational notes:
- **The API key is the only secret.** `user_id` is client-asserted; scope
  partitioning isolates users inside one trusted tenant, it is not an auth
  boundary. A leaked key reads any user's rows. Mint per evaluation, revoke
  after.
- The host must stay awake for the evaluation window (disable sleep during it).
- The container auto-starts with Docker; the tunnel auto-starts at user logon
  (Startup entry) or as a Windows service if installed elevated.
- Store lives on the `hippo-aml-data` Docker volume; it survives container
  replacement. `docker exec hippo-aml sh -c 'ls /data/.hippo'` to inspect.

## Submission state

- [x] Endpoint scaffold (this directory)
- [x] Deploy + external smoke check (https://aml.hippo-memory.com live:
      /health 200, 401 without key, authorized add+search round trip,
      revoked key rejected)
- [ ] AML evaluation access request (https://agentmemories.ai/evaluation - site
      522 since 2026-08-24, request files when it recovers)
- [ ] Compatibility smoke test with the issued AML Key
- [ ] Full evaluation run
- [ ] Publication review
