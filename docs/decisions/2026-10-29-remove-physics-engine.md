# Remove the physics ranking engine: hybrid is the only ranker

Date: 2026-10-29
Status: accepted, ships in 3.0
Links: PR #1106; `docs/UPGRADING-3.0.md:12-18`; `benchmarks/physics-ablation/README.md`;
`docs/evals/2026-09-23-mechanism-audit-result.md`; `docs/evals/2026-09-23-mechanism-audit-round2-result.md`

## Context
Physics scored memories as particles pulled toward the query, with state kept in `memory_physics`
and moved by a sleep pass. Commit 5d1e54703 (2026-09-23) made it opt-in: "physics.enabled defaults
to false: its paired ablation measured it worse on every metric with the CI excluding zero."

## Constraints and evidence
- `benchmarks/physics-ablation/README.md` (60 LongMemEval cases): MRR 0.8388 off vs 0.6848 on,
  95% CI [-0.2556, -0.0529]; Recall@5 84.31% vs 74.17%, CI [-19.17, -1.11] pp.
- `docs/evals/2026-09-23-mechanism-audit-result.md`: "The physics scorer hurts: -22.2 pp hit@5 on
  the slept LongMemEval store, and -19.6 pp on the never-slept store". It adds: "Why it hurts is open."
- `docs/evals/2026-09-23-mechanism-audit-round2-result.md`: "Physics hurts, again, under both
  scorers." Against cosine-only (R5a) it scores "NO MEASURABLE EFFECT", -0.8 pp [-2.4, 0.8].
- `src/db/migrations/v08.ts` creates `memory_physics`; dropping it is a schema change to live data.

## Decision
3.0 deletes the physics engine, its sleep pass, its particle port members and its config keys.
Hybrid search is the only ranker. The `memory_physics` table stays: v08 still creates it, with the
same statements inlined, and nothing reads or writes it.

## What it replaces
- `physicsSearch` and `PhysicsParticle`: `hybridSearch` from `hippo-memory/search` (UPGRADING row 13).
- `mode=physics` on HTTP, `RecallOptions` and MCP `hippo_recall`: `bm25` or `hybrid` (row 14).
- `hippo recall` and `explain` `--physics` and `--classic`: drop the flag (row 15).
- The `physics` config block, `embed --reset-physics`, the sleep pass and the store's particle
  methods: rows 12 and 16 to 18.

## Alternatives considered
- **Keep it opt-in:** the default was already off, but the engine, its sleep pass and the particle
  port methods stayed in the code for a ranker that measured worse.
- **Drop `memory_physics` too:** a migration on live data, left as a follow-up for Keith.

## Reconsider when
- A preregistered paired eval shows a particle-style ranker beating hybrid. The code is in the tree
  at 3f1dddd84 (`src/base/rank/physics.ts`, `src/domain/search/physics-search.ts`) and in v2.0.0 to
  v2.2.0 (`src/core/physics.ts`, `src/search/physics-search.ts`). The table is still in every hippo.db.
