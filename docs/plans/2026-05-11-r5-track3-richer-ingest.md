# LongMemEval R@5 target — Track 3: richer ingest for the features reranker

> **For agentic workers:** execute task-by-task; each task ends in a commit. Stay on the assigned branch; controller pushes.

**Goal:** populate the entry-level signals the features reranker reads (`confidence`, `kind`, `schema_fit`, `strength`, `outcome_score`) using Claude-subagent-extracted values from each LongMemEval session, then re-run the features track and gate on R@5 improvement. Either the features reranker is proven valuable, or it gets removed from `src/`.

**Architecture:** the F6 release shipped `ingest_direct.py` which writes neutral defaults (`confidence='verified'`, `schema_fit=0.5`, `strength=1.0`, `outcome_*=0`) for every session. The features reranker therefore has nothing to discriminate on beyond a small lexical-overlap component. This plan adds an enrichment step: a Python orchestrator splits the 940-session corpus into ~19 batches of ~50 sessions, dispatches one Claude Code subagent per batch (in-session, so the cost is amortised into the controller's billing as directed by the user), and merges per-session signal JSON back into a `signals.jsonl`. A new `ingest_enriched.py` consumes the dataset + signals and populates `hippo_store_enriched/`. The F6 sweep is re-run against the enriched store with the features track.

**Tech stack:** Python 3 (orchestrator + ingest), Claude Code subagent dispatch (signal extraction), Node 22 (existing harness + sweep), Vitest.

**Predecessor:** F6 (`docs/plans/2026-05-10-f6-reranker-hardening.md`). F6 shipped `ingest_direct.py` and the features reranker. F6 result doc reports features R@5 = 75.4% (baseline 75.6%) — features reranker did not meaningfully move R@5 because the ingest path provided no signals to discriminate on.

**Sequencing:** runs after Plan F8 (hybrid tuning) if available. The winning hybrid configuration becomes the harness config; the features-track gate is evaluated against the same configuration's baseline.

---

## Pre-registration

This release does not re-assert the retracted −10pp magnitude.

**Magnitude-smuggling guard.** Per `docs/RETRACTION.md`. Same grep clause as Plans F8 / F9.

**Workload-validity gates (binding):**

- **Gate-A (signal coverage):** the enriched store must have non-default values for at least 80% of memories on at least 3 of the 5 signal fields. Operationalised: a one-shot sqlite query counts how many memories have `confidence != 'verified'` OR `schema_fit != 0.5` OR `strength != 1.0` OR `outcome_positive > 0` OR `outcome_negative > 0`; result must be ≥ 752 (80% of 940). Coverage on each field individually must be ≥ 50% on at least 3 fields.
- **Gate-B (proven value):** features-track R@5 on the ENRICHED store must be ≥ features-track R@5 on the DEFAULT store (= 75.4% from F6) + 5pp. Threshold = 80.4%.

Note: Gate-B compares features-enriched vs features-default, not vs baseline. The point of this plan is to prove the features reranker mechanism CAN move R@5 when given real signals. If features-enriched also matches features-default (i.e. signals don't help), the mechanism is the wrong abstraction for this corpus and should be removed.

**Failure handling:**

- Gate-A FAIL: signal extraction is broken (subagents returned junk, or the merge step lost data). Fix and re-run; not a retraction trigger.
- Gate-B FAIL: **HARD RETRACTION.** The features reranker is removed from `src/` (Tasks 11-13).

**Outside-voice review:** before Task 4 (subagent dispatch) starts, the prereg must pass an outside-voice subagent review.

---

## File structure

| File | Responsibility | Status |
|---|---|---|
| `docs/evals/2026-05-11-r5-track3-richer-ingest-prereg.md` | Pre-registration | CREATE |
| `docs/evals/2026-05-11-r5-track3-richer-ingest-result.md` | Result doc | CREATE (Task 9) |
| `benchmarks/longmemeval/enrich_signals.py` | Batches sessions into per-subagent input JSONs; merges outputs into `signals.jsonl` | CREATE |
| `benchmarks/longmemeval/ingest_enriched.py` | Variant of `ingest_direct.py` that consumes `signals.jsonl` and writes real values | CREATE |
| `benchmarks/longmemeval/data/enrichment_batches/` | Per-batch session JSONs (input to subagents) | CREATE (gitignored) |
| `benchmarks/longmemeval/data/enrichment_outputs/` | Per-batch signal JSONs (output from subagents) | CREATE (gitignored) |
| `benchmarks/longmemeval/data/signals.jsonl` | Merged per-session signals | CREATE (gitignored — large, reproducible) |
| `tests/longmemeval/ingest-enriched.test.mjs` | TDD: enriched ingest applies signals correctly | CREATE |
| `src/rerankers/features.ts` | Features reranker | NO CHANGE (Gate-B PASS) OR DELETE (Gate-B FAIL) |

---

## Tasks

### Task 1: Pre-registration document + outside-voice review

**Files:**
- Create: `docs/evals/2026-05-11-r5-track3-richer-ingest-prereg.md`

- [ ] **Step 1: Write the prereg doc** with the gates and retraction protocol from "Pre-registration" above.
- [ ] **Step 2: Outside-voice review**.
- [ ] **Step 3: Commit.**

### Task 2: Build the batch builder (`enrich_signals.py` part 1)

**Files:**
- Create: `benchmarks/longmemeval/enrich_signals.py`

- [ ] **Step 1: Implement the `build-batches` subcommand**

```python
#!/usr/bin/env python3
"""Three subcommands:
  build-batches: split LongMemEval sessions into per-batch JSON files for subagent input
  merge:        merge per-batch signal output JSONs into signals.jsonl
"""
import argparse, json, sys
from pathlib import Path

def cmd_build_batches(args):
    data = json.loads(args.data.read_text())
    sessions = {}
    for entry in data:
        for sid, dt, turns in zip(entry['haystack_session_ids'], entry['haystack_dates'], entry['haystack_sessions']):
            if sid in sessions: continue
            content_chunks = []
            for t in turns:
                content_chunks.append(f"[{t['role']}] {t['content']}")
            sessions[sid] = {'session_id': sid, 'date': dt, 'text': '\n'.join(content_chunks)}
    sids = sorted(sessions.keys())
    args.out_dir.mkdir(parents=True, exist_ok=True)
    n = 0
    for i in range(0, len(sids), args.batch_size):
        batch = [sessions[s] for s in sids[i:i + args.batch_size]]
        out = args.out_dir / f"batch_{n:03d}.json"
        out.write_text(json.dumps(batch, indent=2))
        n += 1
    print(f"Wrote {n} batches ({len(sids)} sessions) to {args.out_dir}", file=sys.stderr)

def cmd_merge(args):
    out_lines = []
    for f in sorted(args.in_dir.glob('batch_*.signals.json')):
        items = json.loads(f.read_text())
        for it in items:
            out_lines.append(json.dumps(it))
    args.out.write_text('\n'.join(out_lines) + '\n')
    print(f"Wrote {len(out_lines)} signal entries to {args.out}", file=sys.stderr)

def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest='cmd', required=True)
    s1 = sub.add_parser('build-batches')
    s1.add_argument('--data', type=Path, required=True)
    s1.add_argument('--out-dir', type=Path, required=True)
    s1.add_argument('--batch-size', type=int, default=50)
    s1.set_defaults(func=cmd_build_batches)
    s2 = sub.add_parser('merge')
    s2.add_argument('--in-dir', type=Path, required=True)
    s2.add_argument('--out', type=Path, required=True)
    s2.set_defaults(func=cmd_merge)
    args = p.parse_args()
    args.func(args)

if __name__ == '__main__': main()
```

- [ ] **Step 2: Run build-batches**

```bash
mkdir -p benchmarks/longmemeval/data/enrichment_batches
python3 benchmarks/longmemeval/enrich_signals.py build-batches \
  --data data/longmemeval_oracle.json \
  --out-dir benchmarks/longmemeval/data/enrichment_batches \
  --batch-size 50
ls benchmarks/longmemeval/data/enrichment_batches/ | wc -l
```

Expected: ~19 batch files (940 / 50 = 18.8 → 19).

- [ ] **Step 3: Commit script (batch outputs are gitignored)**

```bash
git add benchmarks/longmemeval/enrich_signals.py
git commit -m "feat(longmemeval): enrich_signals.py — batch + merge subcommands

Plan: docs/plans/2026-05-11-r5-track3-richer-ingest.md Task 2"
```

### Task 3: Author the signal-extraction subagent prompt

**Files:** none yet (the prompt lives in the controller's Task-4 dispatch, but draft and validate it here)

- [ ] **Step 1: Draft the prompt**

```
You are a signal extractor. You'll receive a JSON array of conversation sessions. For each session, output ONE JSON object with these fields:

{
  "session_id": "<copy from input>",
  "confidence": "stale" | "inferred" | "verified" | "canonical",
  "kind": "episodic" | "semantic" | "procedural",
  "schema_fit": 0.0-1.0,
  "strength": 0.0-2.0,
  "outcome_positive": 0 | 1 | 2 | 3,
  "outcome_negative": 0 | 1 | 2 | 3
}

Rubrics:

CONFIDENCE
- "canonical": session contains a definitive, externally-verifiable fact (e.g. "The Eiffel Tower is in Paris", official policy, scheduled event).
- "verified": session contains a clearly-stated user/assistant claim with no hedging ("I'll do X tomorrow", "the API returned 200").
- "inferred": session contains a partial / hedged / multi-step claim that requires reading between the lines ("might", "probably", "I think").
- "stale": session is clearly time-bound and the time has passed, OR the claim was contradicted later in the session.

KIND
- "episodic": specific past event with a who/what/when/where ("yesterday I met X", "the meeting on Tuesday").
- "semantic": general fact or preference ("I like pizza", "Python uses indentation").
- "procedural": a how-to / step-list / recipe ("to deploy, run X then Y").

SCHEMA_FIT (0..1)
- How well does the session match a single coherent topic / schema?
- 0.0: random / multi-topic / nothing memorable.
- 0.5: mixed but recognisable.
- 1.0: tight single-topic, clearly memorable.

STRENGTH (0..2)
- How confidently and specifically is the central claim stated?
- 0.0: vague aside.
- 1.0: typical conversational claim.
- 2.0: precise, repeated, with evidence.

OUTCOME_POSITIVE / OUTCOME_NEGATIVE (0..3)
- Did the session reference outcomes (success/failure, did/didn't work)?
- Count each side independently. 0 if no outcome language.

Return ONLY a JSON array of these objects, one per input session. No prose, no markdown fences. Output goes directly into a file.
```

- [ ] **Step 2: Manually validate the prompt on 2 sessions**

```bash
# Take batch_000.json, slice first 2 entries, dispatch ONE subagent manually as a controller-level test.
python3 -c "import json; d=json.load(open('benchmarks/longmemeval/data/enrichment_batches/batch_000.json')); open('/tmp/test_batch.json','w').write(json.dumps(d[:2]))"
# Controller: dispatch subagent with that file and the prompt above; verify output is valid JSON matching the schema.
```

Expected: subagent returns a 2-element JSON array with all required fields and rubric-compliant values.

- [ ] **Step 3: Commit prompt as a docs file** (so it's reviewable + reproducible)

Save the prompt to `benchmarks/longmemeval/enrichment_prompt.md` and commit.

```bash
git add benchmarks/longmemeval/enrichment_prompt.md
git commit -m "docs(longmemeval): signal-extraction subagent prompt + rubric

Plan: docs/plans/2026-05-11-r5-track3-richer-ingest.md Task 3"
```

### Task 4: Dispatch enrichment subagents in batches

**Note:** this task is executed by the CONTROLLER directly — the subagents process sessions and write outputs to files; there is no "run a script" step.

- [ ] **Step 1: Dispatch 19 subagents in waves of 5**

Per-subagent brief:
> Read `benchmarks/longmemeval/data/enrichment_batches/batch_<NNN>.json`. For each session in the array, apply the rubric in `benchmarks/longmemeval/enrichment_prompt.md`. Output a JSON array (one object per input session) to `benchmarks/longmemeval/data/enrichment_outputs/batch_<NNN>.signals.json`. Output ONLY the JSON array — no prose, no markdown fences. Validate with `python3 -c "import json; print(len(json.load(open('benchmarks/longmemeval/data/enrichment_outputs/batch_<NNN>.signals.json'))))"` and report the count back to the controller.

Wave 1: subagents for batches 000-004 in parallel (single message, 5 Agent calls).
Wave 2: 005-009.
Wave 3: 010-014.
Wave 4: 015-018 (4 subagents).

- [ ] **Step 2: Validate all 19 outputs landed**

```bash
ls benchmarks/longmemeval/data/enrichment_outputs/ | wc -l
for f in benchmarks/longmemeval/data/enrichment_outputs/batch_*.signals.json; do
  python3 -c "import json; d=json.load(open('$f')); assert isinstance(d,list); assert all('session_id' in x for x in d); print('$f', len(d))"
done
```

Expected: 19 files, total ~940 entries.

If any batch failed (subagent crashed, output malformed): re-dispatch just that batch.

### Task 5: Merge signals into `signals.jsonl`

- [ ] **Step 1: Run merge**

```bash
python3 benchmarks/longmemeval/enrich_signals.py merge \
  --in-dir benchmarks/longmemeval/data/enrichment_outputs \
  --out benchmarks/longmemeval/data/signals.jsonl
wc -l benchmarks/longmemeval/data/signals.jsonl
```

Expected: ~940 lines.

- [ ] **Step 2: Spot-check signal distribution**

```bash
python3 -c "
import json, collections
sigs = [json.loads(l) for l in open('benchmarks/longmemeval/data/signals.jsonl')]
print('total:', len(sigs))
for k in ['confidence', 'kind']:
    c = collections.Counter(s[k] for s in sigs)
    print(k, ':', dict(c))
import statistics as st
for k in ['schema_fit', 'strength']:
    vals = [s[k] for s in sigs]
    print(k, 'mean=', round(st.mean(vals),2), 'stdev=', round(st.stdev(vals),2))
print('outcome_positive>0:', sum(1 for s in sigs if s.get('outcome_positive',0)>0))
print('outcome_negative>0:', sum(1 for s in sigs if s.get('outcome_negative',0)>0))
"
```

Expected: distribution is non-degenerate (multiple confidence tiers represented; schema_fit not all 0.5; etc.). If everything is one value, the rubric was misinterpreted — re-do Task 4 with a tightened prompt.

### Task 6: Build `ingest_enriched.py` (TDD)

**Files:**
- Create: `benchmarks/longmemeval/ingest_enriched.py`
- Create: `tests/longmemeval/ingest-enriched.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// tests/longmemeval/ingest-enriched.test.mjs
import { test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

test('ingest_enriched applies non-default signal values from signals.jsonl', () => {
  const tmpStore = `/tmp/test_enriched_${Date.now()}`;
  // Use the F6 synthetic_smoke fixture (10 questions, 38 sessions)
  const dataPath = 'benchmarks/longmemeval/data/synthetic_smoke.json';
  // Build a minimal signals file: assign all 38 sessions confidence='inferred', schema_fit=0.9
  const sigPath = `/tmp/test_signals_${Date.now()}.jsonl`;
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const sids = new Set();
  for (const e of data) for (const s of e.haystack_session_ids) sids.add(s);
  const lines = [...sids].map(sid => JSON.stringify({
    session_id: sid, confidence: 'inferred', kind: 'episodic', schema_fit: 0.9, strength: 1.5,
    outcome_positive: 0, outcome_negative: 0,
  }));
  fs.writeFileSync(sigPath, lines.join('\n') + '\n');
  execFileSync('python3', [
    'benchmarks/longmemeval/ingest_enriched.py',
    '--data', dataPath,
    '--signals', sigPath,
    '--store-dir', tmpStore,
  ], { stdio: 'inherit' });
  const db = new DatabaseSync(`${tmpStore}/.hippo/hippo.db`);
  const rows = db.prepare('SELECT confidence, schema_fit FROM memories LIMIT 5').all();
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) {
    expect(r.confidence).toBe('inferred');
    expect(r.schema_fit).toBeCloseTo(0.9, 2);
  }
});
```

- [ ] **Step 2: Run test → FAIL (script doesn't exist yet)**

- [ ] **Step 3: Write `ingest_enriched.py`**

Copy `ingest_direct.py` to `ingest_enriched.py`. Add `--signals` arg. In `ingest_direct(...)` body, load signals into a dict keyed by `session_id`. In the INSERT loop, replace the neutral defaults with values from the signals dict (fall back to defaults if a session is not in the signals file):

```python
sig = signals.get(sid, {})
confidence = sig.get('confidence', 'verified')
kind = sig.get('kind', 'episodic')
schema_fit = sig.get('schema_fit', 0.5)
strength = sig.get('strength', 1.0)
outcome_positive = sig.get('outcome_positive', 0)
outcome_negative = sig.get('outcome_negative', 0)
```

And update the INSERT statement bindings to use these. (Note: the schema in `ingest_direct.py:67-77` uses field names `strength`, `schema_fit`, `confidence`, `outcome_positive`, `outcome_negative` — match exactly.)

- [ ] **Step 4: Run test → PASS**

- [ ] **Step 5: Commit**

```bash
git add benchmarks/longmemeval/ingest_enriched.py tests/longmemeval/ingest-enriched.test.mjs
git commit -m "feat(longmemeval): ingest_enriched.py — applies signals.jsonl to memories

Plan: docs/plans/2026-05-11-r5-track3-richer-ingest.md Task 6"
```

### Task 7: Ingest the real LongMemEval dataset with enrichment

- [ ] **Step 1: Run enriched ingest**

```bash
python3 benchmarks/longmemeval/ingest_enriched.py \
  --data data/longmemeval_oracle.json \
  --signals benchmarks/longmemeval/data/signals.jsonl \
  --store-dir hippo_store_enriched
sqlite3 hippo_store_enriched/.hippo/hippo.db "SELECT COUNT(*) FROM memories;"
```

Expected: ~940 memories in the store.

- [ ] **Step 2: Verify Gate-A signal coverage**

```bash
sqlite3 hippo_store_enriched/.hippo/hippo.db "
SELECT
  SUM(CASE WHEN confidence != 'verified' THEN 1 ELSE 0 END) AS conf_non_default,
  SUM(CASE WHEN ABS(schema_fit - 0.5) > 0.001 THEN 1 ELSE 0 END) AS sf_non_default,
  SUM(CASE WHEN ABS(strength - 1.0) > 0.001 THEN 1 ELSE 0 END) AS str_non_default,
  SUM(CASE WHEN outcome_positive > 0 THEN 1 ELSE 0 END) AS op_non_zero,
  SUM(CASE WHEN outcome_negative > 0 THEN 1 ELSE 0 END) AS on_non_zero,
  COUNT(*) AS total
FROM memories;"
```

Verify Gate-A: at least 3 of the 5 columns must be ≥ 50% of total; AND at least one coverage row must reach 80%.

### Task 8: Run features track on enriched store

- [ ] **Step 1: Determine harness flags**

If Plan F8 ran: read `results/hybrid_tuning_winners.json` and use those flags.
Else: v0.27 defaults.

- [ ] **Step 2: Three runs (baseline, features-default-store, features-enriched-store)**

```bash
mkdir -p results/richer_ingest_$(date +%Y%m%d-%H%M)
SWEEP=$(ls -td results/richer_ingest_* | head -1)
H_FLAGS="[from F8 winners or empty]"

# Baseline against ENRICHED store (validates that the store is queryable and gives us a comparison anchor)
node benchmarks/longmemeval/retrieve_inprocess.mjs \
  --data data/longmemeval_oracle.json \
  --store-dir hippo_store_enriched \
  --output "$SWEEP/baseline_enriched_store.jsonl" $H_FLAGS

# Features against DEFAULT store (re-confirms F6's features result on the default ingest path)
node benchmarks/longmemeval/retrieve_inprocess.mjs \
  --data data/longmemeval_oracle.json \
  --store-dir hippo_store2 \
  --output "$SWEEP/features_default_store.jsonl" \
  --reranker features $H_FLAGS

# Features against ENRICHED store — this is the Gate-B candidate
node benchmarks/longmemeval/retrieve_inprocess.mjs \
  --data data/longmemeval_oracle.json \
  --store-dir hippo_store_enriched \
  --output "$SWEEP/features_enriched_store.jsonl" \
  --reranker features $H_FLAGS
```

- [ ] **Step 3: Score all three**

```bash
for f in "$SWEEP"/*.jsonl; do
  name=$(basename "$f" .jsonl)
  python3 benchmarks/longmemeval/evaluate_retrieval.py \
    --retrieval "$f" --data data/longmemeval_oracle.json \
    --output "$SWEEP/${name}.eval.json"
done
```

### Task 9: Result doc + Gate verdicts

- [ ] **Step 1: Compute Gate-B verdict**

```bash
python3 -c "
import json
fd = json.load(open('$SWEEP/features_default_store.eval.json'))
fe = json.load(open('$SWEEP/features_enriched_store.eval.json'))
print('features-default R@5:', fd['overall']['recall@5'])
print('features-enriched R@5:', fe['overall']['recall@5'])
threshold = fd['overall']['recall@5'] + 5.0
print('Gate-B threshold:', threshold)
print('Gate-B:', 'PASS' if fe['overall']['recall@5'] >= threshold else 'FAIL')
"
```

- [ ] **Step 2: Write result doc** (`docs/evals/2026-05-11-r5-track3-richer-ingest-result.md`) following F6 result-doc template. Include:

- Verbatim retraction sentence on its own line.
- TL;DR with both gate verdicts.
- Provenance: dataset SHA-256 + URL, signal-extraction methodology (which model/agent extracted, total subagent dispatches, total token estimate from Task 4).
- Signal distribution table (output of Task 5 step 2).
- Gate-A signal coverage breakdown.
- R@K table: baseline-on-default-store, baseline-on-enriched-store, features-on-default-store, features-on-enriched-store (overall + per-type).
- Gate-B verdict.
- Roadmap-target framing.
- If Gate-B PASS: "Mechanism shipped, proven valuable when given real signals. The default ingest path (`ingest_direct.py`) is recognized as a limitation; future ingest changes that populate signals will benefit the features reranker on real workloads."
- If Gate-B FAIL: "Retraction protocol triggered — see Tasks 11-13. Features reranker removed from `src/`."
- Outside-voice review (placeholder).

- [ ] **Step 3: Magnitude grep + outside-voice review subagent + commit**

### Task 10: If Gate-B PASS — doc updates and ship

If Gate-B FAILED, skip to Task 11.

- [ ] **Step 1: CHANGELOG entry under v1.X.X — features reranker proven on enriched ingest**

Body: cite result doc, signal distribution, R@K (raw values), include verbatim retraction sentence.

- [ ] **Step 2: README "What's new"** noting that the features reranker is proven valuable when ingest populates entry-level signals.

- [ ] **Step 3: ROADMAP-RESEARCH.md update — F6 entry note**: features track validated under enriched ingest; consider promoting `ingest_enriched` to the default path.

- [ ] **Step 4: evals/README.md update** — add v1.X.X features-on-enriched row.

- [ ] **Step 5: Magnitude grep + commit + push.**

### Task 11: Retraction protocol — code removal (only if Gate-B FAILED)

- [ ] **Step 1: Delete the features reranker**

```bash
git rm src/rerankers/features.ts tests/rerankers/features.test.ts
git rm benchmarks/micro/fixtures/reranker-features.json
```

- [ ] **Step 2: Update the dispatcher**

Edit `src/rerankers/index.ts`: remove the `'features'` case.

- [ ] **Step 3: Build + test**

```bash
npm run build 2>&1 | tail -3
npx vitest run tests/rerankers/ 2>&1 | tail -10
```

Expected: build clean; remaining tests pass.

- [ ] **Step 4: Commit removal**

```bash
git commit -am "$(cat <<'EOF'
revert(rerankers): remove features track per Gate-B FAIL

Plan F10 Gate-B required features-on-enriched-store R@5 >= features-on-
default-store R@5 + 5pp. Observed: <values from result doc>. Even with
Claude-extracted entry-level signals (confidence/kind/schema_fit/
strength/outcome) populated on >80% of memories, the features reranker
did not move R@5 by the threshold. Per the prereg's "proven value or
removed" stance and the v1.8.1 retraction discipline, the track is
removed from src/.

Code removed:
- src/rerankers/features.ts
- tests/rerankers/features.test.ts
- benchmarks/micro/fixtures/reranker-features.json
- 'features' case from src/rerankers/ dispatcher

Result doc: docs/evals/2026-05-11-r5-track3-richer-ingest-result.md
This release does not re-assert the retracted -10pp magnitude.

Plan: docs/plans/2026-05-11-r5-track3-richer-ingest.md Task 11
EOF
)"
```

### Task 12: Documentation retraction (only if Gate-B FAILED)

- [ ] **Step 1: CHANGELOG retraction entry** mirroring Plan F9 Task 10.

- [ ] **Step 2: README "What's new"** retraction entry.

- [ ] **Step 3: ROADMAP-RESEARCH.md F6 entry** — append retraction note for the features track.

- [ ] **Step 4: evals/README.md** — mark v1.9.0 features-* rows as "TRACK RETRACTED".

- [ ] **Step 5: Magnitude grep + commit.**

### Task 13: Push (Gate-B FAIL branch)

- [ ] Push branch and report.

---

## Self-review checklist

- [ ] Spec coverage: enrichment (Tasks 2-5), ingest (Tasks 6-7), evaluation (Task 8), gates + result (Task 9), success path (Task 10), retraction path (Tasks 11-13).
- [ ] Placeholder scan: every step has concrete commands + code.
- [ ] Type consistency: signal field names match across the prompt rubric (Task 3), subagent output schema, signals.jsonl, ingest_enriched.py, sqlite columns.
- [ ] Magnitude grep guard explicitly required at Task 9 step 3 and Task 10/12 step 5.
- [ ] Verbatim retraction sentence required in prereg, result doc, every commit body.
- [ ] Subagent dispatch (Task 4) is in waves of 5 to cap parallelism — controller will be guided by completion notifications, not polling.
- [ ] Retraction protocol is concrete (file paths, dispatcher update, fixture removal) — not "remove the track somehow".
