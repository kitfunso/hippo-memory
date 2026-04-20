# Hippo recall evals

Measurable recall quality. Use `hippo eval <corpus.json>` to run, compare
configs before/after a scoring change, or gate CI with `--min-mrr`.

## Corpora

### `real-corpus.json`

15 hand-written queries with expected memory IDs selected by keyword match
against the current local + global store. Covers a mix of topics: project
rules, dev-environment gotchas, external project references, architecture
notes, and intentional near-duplicates. Some cases expect 1 memory, others
expect 2-9 to exercise MMR diversity.

Regenerate after the store changes significantly:

```bash
node scripts/build-eval-corpus.mjs evals/real-corpus.json
```

The script looks up expected IDs by content keywords, so if the store no
longer contains a matching memory the case will be silently dropped (with a
`WARNING: no matches for ...` line).

### Baseline results (2026-04-20, store ~1088 memories)

| Config | MRR | Recall@5 | Recall@10 | NDCG@10 |
|---|---|---|---|---|
| default (MMR lambda=0.7) | 1.000 | 0.484 | 0.484 | 0.593 |
| --no-mmr | 1.000 | 0.467 | 0.467 | 0.582 |
| --mmr-lambda 0.3 | 1.000 | 0.404 | 0.404 | 0.520 |
| --mmr-lambda 0.5 | 1.000 | 0.415 | 0.432 | 0.540 |
| --mmr-lambda 0.9 | 1.000 | 0.467 | 0.484 | 0.591 |

**MRR = 1.0** across all configs — the first relevant hit is always ranked 1.
**Default lambda=0.7 wins on Recall@10 and NDCG@10**, so the default is
empirically justified rather than arbitrary.

Recall@10 plateauing around 0.48 suggests the embedding index is sparse in
this snapshot (most docs had no cached vector). Running `hippo embed` over
the store is the next obvious follow-up.

## Writing new cases

A case is:

```json
{
  "id": "short-slug",
  "query": "natural-language question a user might type",
  "expectedIds": ["mem_abc123", "g_def456"],
  "description": "optional context so a failure is self-explaining"
}
```

Good cases:

- Use 2-6 expected IDs for queries where MMR matters (there are near-duplicates).
- Use 1 expected ID for "is this specific memory findable?" cases.
- Phrase queries in the user's voice, not in the memory's exact wording.

## Gate CI

```bash
# Fail the run if MRR regresses below 0.9
hippo eval evals/real-corpus.json --min-mrr 0.9
```
