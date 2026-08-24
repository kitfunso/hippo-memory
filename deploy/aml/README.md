# AML evaluation deployment

Public Add/Search endpoint for the [Agent Memory Leaderboard](https://agentmemories.ai)
(open-source methods category). This directory is the complete, reproducible
deployment: anyone can stand up the same endpoint from these three files.

## What AML calls

AML's protocol requires exactly two operations. hippo serves them natively:

| AML operation | hippo route |
|---|---|
| Add | `POST /v1/memories` |
| Search | `GET /v1/memories?q=<query>&limit=<n>` |

Auth is a bearer token validated against a store-resident API key
(scrypt-hashed at rest, tenant-scoped). Health: `GET /health`.

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
  the volume). `hippo init` run from `/data` creates it; `serve` resolves it
  from the working directory.
- **Single always-on machine, 1GB**: the local embedding model needs the
  memory, and the ~5,000-question evaluation must not hit a cold start.

## Operating it

```sh
# deploy (from the repo root)
flyctl deploy --config deploy/aml/fly.toml --dockerfile deploy/aml/Dockerfile

# mint the evaluation key (shown ONCE; hippo stores only a hash)
fly ssh console -a hippo-aml -C "node /app/dist/src/cli.js auth create --label aml-eval --role member --json"

# smoke-check from outside
curl https://hippo-aml.fly.dev/health
curl -H "Authorization: Bearer <key>" "https://hippo-aml.fly.dev/v1/memories?q=test"
```

## Submission state

- [x] Endpoint scaffold (this directory)
- [ ] Deploy + external smoke check
- [ ] AML evaluation access request (https://agentmemories.ai/evaluation)
- [ ] Compatibility smoke test with the issued AML Key
- [ ] Full evaluation run
- [ ] Publication review
