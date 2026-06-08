# Frontier-embedder LongMemEval benchmark (Workstream C handoff)

**Status:** TODO. Must run on a host with API egress and a key. The build sandbox
blocks `api.openai.com` (and the HF Hub), so this cannot run in CI / in-sandbox.

## Why

Every local F-track measurement (F9 hybrid RRF, F14/F15/F16 embedder swaps)
reached the same conclusion: on the comparable `longmemeval_s` split, the
**local embedder is the structural ceiling**, not the fusion or chunking signal
mix. gbrain v0.28.8's 97.6 R@5 uses OpenAI `text-embedding-3-large`. v1.23.0
makes the embedder pluggable (see `src/embedding-provider.ts`), so we can finally
measure hippo's retrieval with a frontier embedder and publish the number
honestly, next to the zero-dependency local floor.

## What to measure (dual numbers, honestly labelled)

Report BOTH, never just the frontier number:

| Configuration | What it represents |
|---|---|
| **Zero-dep local floor** | the shipped default: BM25 + local `@xenova/transformers` (MiniLM). Published today as R@5 = 74.0 (BM25 lineage) / 76.2 (canonical hybrid harness). |
| **Frontier** | `provider: openai`, `model: text-embedding-3-large`, same harness/split. |

Carry the same split-mismatch disclosure the F-track docs carry: oracle (3
sessions/haystack) is cross-comparison only; the binding gbrain-comparable number
is on `longmemeval_s` (~40 sessions/haystack) acquired from the documented mirror
with no signed chain-of-custody to the canonical HF release.

## Procedure

Prereqs: a host with outbound HTTPS to `api.openai.com`, `OPENAI_API_KEY`
exported, and the local LongMemEval harness (maintained under the gitignored
`benchmarks/longmemeval/` working tree, not shipped in the package).

1. **Wire the provider into the harness embed step.** The LongMemEval harness
   embeds turns with its own script (e.g. `chunk_per_turn_embed.mjs`), which calls
   an embedder directly rather than through hippo's CLI. Point that embed step at
   the new provider: either import `resolveEmbeddingProvider(hippoRoot)` and call
   `provider.embed(texts, 'passage')`, or replicate the OpenAI call (POST
   `/v1/embeddings`, `text-embedding-3-large`, L2-normalize). Use the same
   provider for the query side with role `'query'`.
2. **Build the index** for the chosen split (oracle for cross-comparison, `_s`
   for the binding gate). text-embedding-3-large is 3072-dim, so expect a larger
   index than the 768-dim BGE runs.
3. **Run the canonical retrieval eval.** Use the in-process hybrid harness with
   `budget 1000000` and `min-results 10`. **Never** use `retrieve.py --budget
   4000` (documented trap: caps recall at ~14.8%; see
   `benchmarks/longmemeval/LONGMEMEVAL_RESOLVED.md`).
4. **Score** with `evaluate_retrieval.py` (R@1/3/5/10 + answer_in_content@5).
5. **Re-run the zero-dep local floor** through the identical harness/split so the
   two numbers are apples-to-apples.

## Reporting template

```
LongMemEval <split> (<N> questions, <M> sessions/haystack)
  Zero-dep local default (BM25 + MiniLM):   R@5 = XX.X
  Frontier (text-embedding-3-large):        R@5 = YY.Y   (+Z.Z)
  gbrain v0.28.8 reference:                 R@5 = 97.6   (text-embedding-3-large, _s)
Split / embedder comparability caveats: <disclosure>
```

Publish the pair on the site/README only after an outside-voice review of the
result doc, per the established eval-publishing discipline. The honest framing is
"zero-dep floor + opt-in frontier ceiling", not a single headline number.

## Cost note

text-embedding-3-large is billed per token. Embedding the full `_s` corpus
(~200k turns) is a non-trivial spend; estimate before running and use the
provider `batchSize` to control request volume.
