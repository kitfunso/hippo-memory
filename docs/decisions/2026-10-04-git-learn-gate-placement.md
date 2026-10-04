# Git learn: the low-information gate filters the loop input

Date: 2026-10-04
Status: accepted
Links: `src/api/learn.ts` (`learn`, shared by `hippo learn --git`, init, sleep and MCP `hippo_learn`); `src/autolearn.ts` `partitionLessons`

This record holds the reasoning that used to sit as a long comment over the CLI learn loop. The code moved to `api.learn`.

## Context
The admission gate lives at the write path, not in `extractLessons`, which is a published API surface that only parses.
Bare subjects like "fixed signals" are dropped there, before they ever become a memory.
The open question was where in the loop the gate sits: on the loop input, or on the write alone.

## Decision
The gate filters the loop input, so a dropped lesson neither stores nor invalidates.

One review called the lost invalidation serious: a migration subject too thin to store ("replace webpack with vite") would stop weakening stale webpack memories.
So the loop was widened to walk every parsed lesson with the gate on the write alone.

A second review found the cure was worse. Storage is what makes invalidation idempotent here.
A stored lesson is recognised by its same-text key on the next scan and short-circuits before invalidating again.
A lesson that invalidates but is never stored has no such record, so every rescan re-invalidates, and `invalidateMatching` halves `half_life_days` each time.
Measured: 7 -> 3 -> 1 over two runs. That is compounding data damage.

Measured frequency decided it. Across 413 real auto-learn rows in 4 stores, 24 are gated and none of those carry an invalidation target.
The 45 lessons that do carry targets all pass the gate and are unaffected either way.
Both failure modes are empty on real data, so the tie breaks on which one is benign if it ever fires: not invalidating is a missed improvement, re-invalidating forever is damage.

## Consequences
A migration subject too thin to store also does not invalidate; a test pins this.
Making `invalidateMatching` idempotent would allow both, and is backlogged. It is a latent issue for the manual `hippo invalidate` path too.
The MCP profile does not invalidate at all, so for it the gate only decides what is written.
