# B — Pluggable EmbeddingProvider (opt-in API embedders; local stays the zero-dep default)

**Episode:** `01KTM0X9GF97MSE8RQY054X210` (dev-framework-rl)
**Branch:** `feat/embedding-provider` off `origin/master` 4f8c7cc
**Date:** 2026-06-08

## Why

Every F-track (F9/F14/F16) reached the same conclusion: on the comparable LongMemEval
`_s` split the **local embedder is the structural ceiling**, not the fusion/chunking
signal mix. gbrain's 97.6 uses OpenAI `text-embedding-3-large`. The only lever that
moves the score people compare is the embedder itself. B makes the embedder pluggable
so a user can bring a frontier API embedder, while the default stays local + zero-dep.

## Goal

Let a user opt in to an API embedder (OpenAI / Voyage / Cohere) via config + an env key,
getting frontier-class retrieval, while the out-of-box default remains the local
`@xenova/transformers` path with zero API keys and zero new runtime dependencies.

## Non-goals

- No plugin marketplace / user-registerable provider DI. (Simplicity First.)
- No change to default behavior. `provider` defaults to `local`; existing stores must
  never be force-reindexed on upgrade.
- No rerank, no chunk-per-turn ingestion (those are Workstream A — separate).
- No real-API integration test in this episode — `api.openai.com` is egress-blocked
  in-sandbox. That test is Workstream C, on a box with egress + key.

## Design

### 1. Provider interface — `src/embedding-provider.ts` (new)

```ts
export interface EmbeddingProvider {
  /** Identity token recorded in DB meta to drive reindex-on-change.
   *  local  -> bare model string (BACK-COMPAT, unchanged): 'Xenova/all-MiniLM-L6-v2'
   *  api    -> '<provider>:<model>': 'openai:text-embedding-3-large'           */
  readonly id: string;
  /** Fixed output dimension if known (api models), else undefined (local). */
  readonly dimensions?: number;
  /** Batch embed. Returns one row per input; a row is [] on per-item failure.
   *  Batch-first because API cost/latency demands it; local maps over the
   *  existing single-text path. */
  embed(texts: string[], role?: EmbeddingRole): Promise<number[][]>;
}
```

### 2. Resolution — `resolveEmbeddingProvider(hippoRoot, config)`

- `local` (default) → wraps the existing `loadPipeline` / per-model `poolingFor` /
  `prefixFor` / `preferredBackend` logic **byte-identically**. No behavior change.
- `openai` / `voyage` / `cohere` → native `fetch` (Node >= 22.5, **no new dep**),
  key from a conventional env var (`OPENAI_API_KEY` / `VOYAGE_API_KEY` /
  `COHERE_API_KEY`), provider endpoint, batched request, L2-normalize the returned
  vectors to match the local contract (`getEmbedding` returns normalized vectors).
- Provider value validated against an allow-list. Provider != local with a missing
  key → throw a clear, **key-redacted** error at resolve time (fail fast at the
  boundary; never write a partial index).

### 3. Config — `src/config.ts`

Extend `embeddings`:

```ts
embeddings: {
  enabled: boolean | 'auto';
  model: string;
  hybridWeight: number;
  provider?: 'local' | 'openai' | 'voyage' | 'cohere'; // default 'local'
  apiBaseUrl?: string;   // optional endpoint override (self-host / proxy)
  batchSize?: number;    // default 64 for api providers
}
```

Merge with defaults the same way every other sub-object is merged in `loadConfig`.

### 4. Identity & reindex (the back-compat crux — each gets a test)

- Local identity stays the **bare model string** → existing stores with meta
  `embedding_model = 'Xenova/all-MiniLM-L6-v2'` see **no identity change, no forced
  reindex** on upgrade.
- API identity = `'<provider>:<model>'`.
- `embeddingModelRequiresReindex` compares stored identity vs resolved provider `id`.
  Switching to/from an API embedder (or a dim change 384/768/3072) triggers the
  **existing** full `rebuildEmbeddingIndex` + `resetPhysicsFromIndex` path. No new
  migration machinery.

### 5. Wiring — `src/embeddings.ts`

- `getEmbedding(text, model, role)` keeps its signature (back-compat); routes through
  the resolved provider's `embed([text], role)[0]`.
- `embedAll` / `rebuildEmbeddingIndex` call the provider's **batch** `embed(texts)` in
  chunks of `batchSize` → large speed/cost win for API providers; local is effectively
  one-at-a-time as today.
- `isEmbeddingAvailable()` unchanged for local (dependency check). For API providers,
  "available" = key present (surfaced, not thrown, where the codebase currently treats
  embeddings as best-effort on the add path).

### 6. CLI — `src/cli.ts`

`hippo embed` / status surfaces the active provider, model, and **key-present yes/no**
(never the key value). No other CLI change — provider is resolved inside the embedding
layer.

## Files

| File | Change |
|---|---|
| `src/embedding-provider.ts` | NEW — interface + `resolveEmbeddingProvider` + local & api impls (split api into `src/embedding-providers/{openai,voyage,cohere}.ts` if the file grows past ~300 lines). |
| `src/embeddings.ts` | EDIT — route get/embedAll/embedMemory/rebuild through provider; identity helper. |
| `src/config.ts` | EDIT — add `provider`/`apiBaseUrl`/`batchSize` + merge. |
| `src/cli.ts` | EDIT — surface provider + key-present in embed/status output. |
| `tests/embedding-provider.test.ts` | NEW — provider units (mocked `fetch`), identity/back-compat, missing-key error, batch chunking. |
| `README.md` / `CHANGELOG.md` | EDIT at ship (publish-repo workflow). |

## Backwards-compat guarantees (each is a test)

1. `provider` unset / `local` → behavior byte-identical; `embeddings.json` + meta
   untouched; no reindex on upgrade.
2. Switching `provider` -> `openai` triggers exactly one full reindex (identity change),
   then stable across runs.
3. `provider` set, key missing → clear redacted error, **no** partial index writes.

## Security

- Keys read from env only; never written to config, DB, logs, or error text (redact in
  all error paths).
- HTTPS endpoints only; `provider` validated against the allow-list before any fetch.

## Verification (goal-driven; loop until green)

- `npm run build` clean (tsc + benchmarks tsconfig).
- `npx vitest run` all green incl. new provider tests (mocked fetch — no network).
- Existing embeddings / search / config tests unchanged and passing (proves the local
  default path is untouched).
- Manual integration (DEFERRED to Workstream C, documented in README): set
  `OPENAI_API_KEY`, run `hippo embed`, confirm 3072-dim vectors + recall lift.

## Deferred / handoff

- **Workstream C:** matched-split LongMemEval with the API embedder, on a box with
  egress + key; publish dual numbers (local zero-dep floor + frontier number, honestly
  labeled). Ship a one-command runner as part of C.
- **Workstream A:** RRF-as-default + chunk-per-turn ingestion port — separate, later.

## Consolidated review revisions (senior-code-reviewer, applied 2026-06-08)

Plan-stage outside-voice review found 2 blocking seam bugs + 10 more. Corrected design:

**Provider encapsulates its model.** `resolveEmbeddingProvider(hippoRoot, config?)` returns
a provider that already knows its model + identity + availability. Callers stop passing a
bare `model` string and use `provider.embed()` / `provider.isAvailable()`.

1. **(C1) Availability is provider-aware at ALL gate sites.** `isEmbeddingAvailable()` (local
   package check) is replaced at the 8 gate sites (`embeddings.ts` getEmbedding/embedMemory/
   embedAll, `search.ts` hybridSearch+physicsSearch query-embed, `capture.ts`, `cli.ts`
   add/embed) with `resolveEmbeddingProvider(hippoRoot).isAvailable()` — local→package check,
   api→key present. `isEmbeddingAvailable()` is retained as the local provider's check.
2. **(C2) Reindex compares identity, not bare model.** New `resolveEmbeddingIdentity(hippoRoot,
   config?)` returns `provider.id` (local→bare model, api→`provider:model`). Every
   `embeddingModelRequiresReindex` comparison + every `saveStoredEmbeddingModel` uses the
   identity. Local identity = bare model preserves no-reindex-on-upgrade.
3. Back-compat test uses a real DB fixture (`embedding_model='Xenova/all-MiniLM-L6-v2'`) →
   assert `requiresReindex===false` + byte-identical `embeddings.json`.
4. **Failure semantics per site.** `resolveEmbeddingProvider` never throws. Hot paths
   (getEmbedding, add, search) swallow to `[]`/BM25 (back-compat — `getEmbedding` never throws).
   Only the explicit `hippo embed`/`embedAll` path throws a redacted fatal when a set provider's
   key is missing. `provider.embed()` may throw on HTTP/auth error; callers apply their contract.
5. Dim-change (384→3072): test local→api asserts full rebuild + physics reset count>0 + no
   mixed-dim vectors survive.
6. **Atomic reindex.** On any batch error during `rebuildEmbeddingIndex`, abort WITHOUT saving
   index/identity (old index + identity preserved). Incremental `embedAll` may save partial
   (resumable). Test mid-rebuild failure.
7. Role mapping: API providers map `role`→`input_type` (Voyage/Cohere) / no-op (OpenAI);
   `prefixFor` (e5) stays local-only.
8. `enabled:'auto'` for non-local provider = enabled iff key present.
9. Mocked-fetch tests pin request contract (endpoint, auth header, batch body, input_type) AND
   assert returned-vector L2 norm ≈ 1.0 (the `normalize:true` contract `cosineSimilarity` needs).
10. `redactKey(err)` wrapper on every provider `throw`; test a 401 with key in body asserts key
    absent from the surfaced error.
11. CLI status surfaces provider:model, dims, key-present, and reindex-pending.
12. `apiBaseUrl` validated `https:` (or explicit localhost); allow-list governs the provider name.
