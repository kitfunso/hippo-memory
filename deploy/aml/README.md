# AML evaluation deployment

Public Add/Search endpoint for the [Agent Memory Leaderboard](https://agentmemories.ai)
(open-source methods category), live at **https://aml.hippo-memory.com**.

Host: a self-managed machine running the Docker image below, published to the
internet through a named Cloudflare Tunnel. No inbound ports are open on the
host; the tunnel makes outbound connections to Cloudflare's edge, and the
container's port is bound to 127.0.0.1 only.

## What AML calls

AML's protocol requires exactly two operations. hippo serves them natively:

| AML operation | hippo route |
|---|---|
| Add | `POST /v1/memories` |
| Search | `GET /v1/memories?q=<query>&limit=<n>` |

Auth is a bearer token validated against a store-resident API key
(scrypt-hashed at rest, tenant-scoped). Health: `GET /health` (public,
liveness-only body for non-loopback callers).

An adapter translating AML's exact request/response schema onto these routes
lands in this directory once written against the published API guide
(https://agentmemories.ai/api-guide). If the schemas already align, no adapter
is needed and this note gets replaced by that finding.

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
# 1. Build the image (from the repo root)
docker build -f deploy/aml/Dockerfile -t hippo-aml:prod .

# 2. Run the container: loopback-only publish, survives restarts
docker volume create hippo-aml-data
docker run -d --name hippo-aml --restart unless-stopped \
  -v hippo-aml-data:/data \
  -p 127.0.0.1:18080:8080 \
  -e HIPPO_CLIENT_IP_HEADER=cf-connecting-ip \
  hippo-aml:prod

# 3. Cloudflare Tunnel (one-time): authorize the zone, create, route
cloudflared tunnel login
cloudflared tunnel create hippo-aml
cloudflared tunnel route dns hippo-aml aml.hippo-memory.com

# 4. ~/.cloudflared/config.yml
#    tunnel: <tunnel id>
#    credentials-file: <path printed by tunnel create>
#    ingress:
#      - hostname: aml.hippo-memory.com
#        service: http://localhost:18080
#      - service: http_status:404

# 5. Run it (or install persistence: `cloudflared service install` from an
#    admin shell, or a user Startup entry running `cloudflared tunnel run hippo-aml`)
cloudflared tunnel run hippo-aml
```

## Operating it

```sh
# mint the evaluation key (shown ONCE; hippo stores only a scrypt hash)
docker exec -w /data hippo-aml node /app/dist/src/cli.js auth create --label aml-eval --role member --json

# revoke a key
docker exec -w /data hippo-aml node /app/dist/src/cli.js auth revoke <keyId>

# smoke-check from outside
curl https://aml.hippo-memory.com/health
curl -H "Authorization: Bearer <key>" "https://aml.hippo-memory.com/v1/memories?q=test"
```

Operational notes:
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
