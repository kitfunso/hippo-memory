# Q3b ranker floor check

The harness for [the pre-registration](../../docs/evals/2026-10-04-q3b-ranker-floor-prereg.md). Read that file first: it fixes the arms, the corpus, the metric and the decision rule. This directory only carries them out.

**This is a retrieval-floor check.** It picks which of three ranking cores the one recall entry point keeps. It is not a success measure for hippo, and its result must not be quoted as one. No LongMemEval or LoCoMo number is part of it.

**Status: written, not run.** No arm has been scored on either corpus.

## What it does

All three arms call `retrieve()` (`src/api/recall.ts`) in process, on a real store.

| Arm | Request |
|---|---|
| A, CLI core | the `cliCore` option, with the request `hippo recall` builds |
| B, HTTP SQL BM25 | no `mode` and no ranker option, as `GET /v1/memories` calls it |
| C, MCP showRanked | the `showRanked` option, with the options the MCP recall tool passes |

It scores 38 queries per arm: the 33 micro-eval queries and 5 queries on a 1,600-row window fixture. It then times `retrieve()` on the window fixture and reports a p99 over 150 timed runs per arm.

## Run it

```bash
npm run build
npm install --no-save @huggingface/transformers@4.2.0

# The window fixture alone: builds 1,600 rows and checks each target's BM25 row. No arm, no embeddings.
node --experimental-strip-types benchmarks/q3b-ranker-floor/window-fixture.ts

# What each arm would be asked. Builds no store and calls no arm.
node --experimental-strip-types benchmarks/q3b-ranker-floor/run.ts --plan

# The run itself.
node --experimental-strip-types benchmarks/q3b-ranker-floor/run.ts
```

`run.ts` takes `--out <file>` (default `results/result.json` here), `--keep` to leave the work directory in place, and `--python <exe>` for the interpreter that runs `benchmarks/micro/run.py`'s preflight.

The run exits non-zero and writes no result when:

- the Transformers.js backend is missing, or `run.py`'s embedding preflight fails;
- a micro fixture or its query count differs from the 13 and 33 the pre-registration fixes;
- a window target sits outside rows 201 to 1,000 of the BM25 order;
- a window row has no vector;
- an unlifted control target appears in any arm's top 5.

## Files

| File | Holds |
|---|---|
| `queries.ts` | the micro queries as stage lists, which arm runs which stage, and `run.py`'s pass rule |
| `sandbox.ts` | the sandbox both the built CLI and the in-process calls see, and the fresh copy per query |
| `micro-store.ts` | a micro fixture's store, built with the built CLI in `run.py`'s order |
| `window-fixture.ts` | the seeded window fixture and its placement check |
| `arms.ts` | the three requests |
| `report.ts` | pass counts, p99, disagreements, the locked decision rule |
| `run.ts` | the run and the `--plan` listing |

## Stages an arm cannot run

The pre-registration hands every arm one shared stage list. It also says: when an arm cannot run a stage a query asks for, that query counts as a fail for that arm.

Today `retrieve()` takes the whole stage list only under `cliCore`. Arms B and C take a session id, which runs the goal boost from the session's goal stack, and nothing else. `goalTag` on those two only switches that boost off; it boosts no named tag.

So 12 of the 33 micro queries fail for arms B and C by rule, before either arm is called. `--plan` prints each one with the stage it needs. A run on this code therefore mostly measures that gap. Letting every ranker take the stage list is a `src` change and is not part of this harness.

## Choices fixed before any run

The pre-registration leaves these open. They are fixed here, in the commit that adds the harness.

- **Rows shown: 10 per arm.** Each arm shows and records its top 10, the HTTP default band. `retrieve()` strengthens what it shows, so equal counts keep the timed writes equal.
- **Arm A's budget is priced on content tokens.** `hippo recall` prices each printed line. The harness prints nothing, so it prices the row's own token count.
- **A fresh copy goes back to the path the store was built at.** The path boost reads the directory names of the cwd, so a copy at a new path would rank differently.
- **Each query pushes only its own goals.** `run.py` runs a fixture's queries on one shared store. Here each query starts from the built store, as the pre-registration requires.
- **Timing covers the `retrieve()` call alone.** Config load and request building sit outside the timer. Each query and arm gets a fresh copy, 3 warm-ups, then 30 timed calls. The arm order rotates per query.
- **Timed calls record.** Each call strengthens the rows it shows, so later calls in a series read a store the earlier ones wrote to. That is the same for every arm.
- **p99 is nearest rank:** of 150 samples, the 149th smallest.
- **Decision rule step 2 is read as written:** with no two-query margin, the arm with the lowest p99 of all three wins. An exact p99 tie reports no winner.
- **Window rows are embedded with `embedAll`,** the call `hippo embed` makes, after the rows are written.

## The window fixture

Every row holds both query words, `turbine` and `gasket`. That follows from the spec: strong rows hold the terms twice, weak rows and targets once. With a term in every row, SQLite FTS5 clamps its IDF to a floor. The BM25 order then comes from term count and row length alone.

- 600 strong rows: both terms twice, 4 filler words.
- 990 weak rows: both terms once, 30 to 44 filler words.
- 10 targets: both terms once, 2 filler words. Two are pinned, two carry the tag of an active goal, one has three good outcomes, five have no lift.

Each row starts with a marker no other row holds, such as `wfxt03`. A query names its target by that marker. The marker is not a query term, so it does not rank the row.

The seed is fixed, and one timestamp stamps every row, so age lifts none of them over another.
