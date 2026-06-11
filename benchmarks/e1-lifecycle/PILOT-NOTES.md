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

## Pilot 2 — pending (rescaled generator)
