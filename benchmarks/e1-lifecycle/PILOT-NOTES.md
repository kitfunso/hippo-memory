# E1 pilot notes (pre-freeze; design v0.2 saturation-guard clause)

Per PREREGISTERED-DESIGN.md section 3 E1: pilot-stage rescales are allowed BEFORE the
`e1-generator-freeze` tag, must be recorded here with their trigger, and stop being legal
the moment the tag exists.

## Pilot 1 — 2026-06-11, generator 1.0.0 (4 negative families), seed 1, 300 facts / 20 sessions / 10x distractors

| final epoch | full | all-off | guard [0.10, 0.90] |
|---|---|---|---|
| current R@5 | 0.333 | 0.943 | all-off VIOLATES (>0.90) |
| stale-intrusion | 0.600 | 0.975 | all-off VIOLATES |
| trap-persistence | 0.089 | 0.933 | all-off VIOLATES |
| hot R@5 | 0.435 | 0.930 | all-off VIOLATES |

Wall-clock: full 206.8s, all-off 104.8s per (arm x seed). Full registered matrix
(7 arms x 20 seeds) projects to ~6-7h serial, local, $0.

**Diagnosis:** the probe query ("entity attribute") collides on BOTH tokens with only
~4-6 documents per fact (versions + contradiction + trap + paraphrase-negative). With
top-5 slots, a static BM25 ranking can hold essentially all of them - the all-off
baseline saturates (everyone gets an A; the exam differentiates nothing).

**Directional preview (not registered results):** mechanisms differentiate strongly and
in OPPOSITE directions - outcome feedback buries traps (0.089 vs 0.933); decay appears
to sacrifice old-but-current facts to fresher distractors (full current R@5 0.333 vs
0.943; 7-day default half-life across a 20-week horizon floors every old memory's
strength multiplier at 0.5x while fresh noise keeps ~1.0x). If this holds under the
rescaled protocol and the registered arms, the decomposition (which mechanism helps,
which hurts, at what horizon) is the paper's core result. H2's pivot criteria adjudicate.

**Rescale applied (generator 1.0.0 -> same version pre-freeze, family count 4 -> 5):**
added a BOTH-token hard-negative family (same entity AND attribute in a meta/process
sentence carrying its own NEG token), so every fact now has more both-token colliders
than top-5 slots and the static baseline must actually rank. No other change.

## Pilot 2 — 2026-06-11, both-token meta-sentence family, seed 1

FAILED to de-saturate: all-off currentR5 0.967 (worse than pilot 1). Root cause: the new
negatives were LONGER sentences; BM25 length normalization ranks them below the tight fact
docs, so they never displace anything from top-5.

## Pilot 3 — 2026-06-11, value-claim lookalike family (exact fact template, own token), seed 1

| final epoch | full | all-off | guard [0.10, 0.90] |
|---|---|---|---|
| current R@5 | 0.257 | 0.727 | PASS |
| stale-intrusion | 0.475 | 0.875 | PASS |
| trap-persistence | 0.111 | 0.733 | PASS |
| hot R@5 | 0.365 | 0.757 | PASS |

Wall-clock: all-off 102.0s, full 167.5s. Registered matrix (7 arms x 20 seeds) projects ~6h.

**Trajectory note -> amendment A2:** epochs 0-9 are ceiling-saturated by construction (an
accumulating store starts with 1-3 docs per fact; a top-5 metric cannot miss). Primary
endpoints clarified to FINAL-EPOCH values (prereg amendment A2, recorded pre-freeze);
trajectories reported descriptively. Final-epoch all-off passes the guard on all metrics.

Directional preview persists (not registered results): outcome feedback buries traps
(0.111 vs 0.733); full-lifecycle current R@5 BELOW all-off (0.257 vs 0.727 - decay
sacrifices old-but-current facts to fresh noise at this horizon); stale-suppression helps
(0.475 vs 0.875). The per-mechanism arms will attribute these causally.

## Pilot 4 - 2026-06-11, post codex-round-1 fixes (deterministic ids, disjoint contradictions)

| final epoch | full | all-off | guard [0.10, 0.90] |
|---|---|---|---|
| current R@5 | 0.320 | 0.727 | PASS |
| stale-intrusion | 0.475 | 0.825 | PASS |
| trap-persistence | 0.067 | 0.778 | PASS |
| hot R@5 | 0.480 | 0.693 | PASS |

Wall-clock: all-off 87.2s, full 161.1s. Reproducibility now proven by invariant test
(two identical (arm, seed) runs produce byte-identical metrics; entry ids derived from
(seed, protocol id) instead of random UUIDs). Contradiction facts disjoint from updated
facts (attribution unconfounded). Guard passes; protocol ready to freeze pending codex
convergence.
