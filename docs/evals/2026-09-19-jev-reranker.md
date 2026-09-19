# Jev reranker: what was measured, what it costs, what it does not do

Date: 2026-09-19. Applies to `--reranker jev` (`src/rerankers/jev.ts`), added in 1.42.0.

## Summary

`jev` is an opt-in reranker. It sends the query and the top candidates to the hosted TypeSafe Jev API and reorders them by the returned probabilities. It ranks better than the local cross-encoder on two corpora. It has not been shown to produce better answers. It is off by default, and the default recall path makes no network call.

## Use

    export TYPESAFE_API_KEY=...        # from the TypeSafe dashboard
    hippo recall "why did the deploy fail" --reranker jev

| Env var | Default | Meaning |
|---|---|---|
| `TYPESAFE_API_KEY` | unset | Bearer token. Read from the environment only. Hippo never stores or prints it. |
| `HIPPO_JEV_TIMEOUT_MS` | 5000 | Abort the request after this many ms. |
| `HIPPO_JEV_MODEL` | `jev-latest` | Model name sent to the API. |

Request shape: one POST per recall to `https://api.typesafe.ai/v1/systemone`. The `state` field holds the query and the numbered candidates, each cut to 1,200 characters. There is one `noul` question per candidate, and each answer is a probability from 0 to 1. `hippo recall --reranker jev` scores the top 40 candidates by default, the pool every number below was measured at; `--reranker-top-k` overrides it, and the fallback reranks the same slice.

## What leaves the machine

The query text and the text of every candidate memory go to a third-party API. Do not turn `jev` on for a store that holds content you cannot send to a vendor.

## Failure behaviour

Any failure falls back to the local cross-encoder and prints one warning per process to stderr naming the reason: key unset, a non-2xx status (with the request id when the API sends one), a timeout, a network error, or an answer set that is incomplete or out of range. The reranker never throws and never returns a half-scored order. If the local cross-encoder backend is also missing, that reranker returns the input order and prints its own one-time warning.

## Evidence

All numbers are aggregates over paired bootstrap runs of 2000 draws. Ranking intervals are 98.75%. Graded-answer intervals are 98.33%.

Ranking on a private developer store, n=300 queries, 40 candidates each:

| Metric | Base | Cross-encoder | Jev | Jev minus cross-encoder |
|---|---|---|---|---|
| R@1 | 0.2600 | 0.4133 | 0.6167 | +0.2033 [0.1333, 0.2733] |
| R@5 | 0.4600 | 0.6133 | 0.7400 | +0.1267 [0.0800, 0.1767] |
| MRR | 0.3584 | 0.5086 | 0.6719 | +0.1633 [0.1134, 0.2168] |
| recall at the token budget | 0.6933 | 0.7400 | 0.7467 | +0.0067 [0.0000, 0.0200], tied |

The R@1 margin was significant in 20 of 20 bootstrap seeds. A permutation null with arm labels shuffled within each query reached it in 0 of 200 runs.

Ranking on LongMemEval, n=500: Jev minus cross-encoder on R@1 is +0.0700 [0.0200, 0.1200]. R@5 is +0.0380 [0.0000, 0.0740], tied. On this corpus the cross-encoder did not beat base on any ranking metric.

Graded answers on LongMemEval, n=150, exact-answer rate:

| Test | Result | Reading |
|---|---|---|
| Jev against cross-encoder, 5 memories each | -0.0067 [-0.0533, 0.0400] | tied |
| Jev top 2 against base top 40 | -0.0133 [-0.0533, 0.0200] | tied, at about 600 tokens against about 12,000 |
| Every arm at 2 memories | base 0.0867, cross-encoder 0.1067, Jev 0.1400 | Jev minus cross-encoder +0.0333 [-0.0067, 0.0800], not shown. Jev minus base +0.0533 [0.0200, 0.1000]. |
| Jev at 2 memories against cross-encoder at 5 | -0.0133 [-0.0467, 0.0133] | tied |
| Cross-encoder against base, 5 memories each | +0.0467 [0.0133, 0.0867] | the free reranker lifted answers |

Reading: the ranking win holds on two corpora. An answer win over the free cross-encoder was not shown in three graded tests, and those three tests share one 150-question set, so they are not three independent tries. What Jev buys today is a shorter context: 2 memories ranked by Jev answer as well as 5 ranked by the cross-encoder, about 900 fewer tokens a query.

## Cost and latency

Measured over 300 rerank calls of 40 candidates: p50 295 ms, p90 414 ms, max 953 ms, 300 of 300 HTTP ok, total cost 0.12 USD. That is about 0.0004 USD a recall.

## Limits

- Jev never abstains. On a query with no valid answer in the pool it still ranks something first. A high score is not proof that an answer exists.
- `noul` answers carry no confidence field (0 of 500 calls returned one), so there is nothing to threshold on.
- Scores are not bit-stable. Repeat calls on identical input moved a score by up to 0.06, so near-ties can swap order between runs. This is the documented exception to the determinism rule in `src/rerankers/types.ts`.
- Jev scores are coarse: 97 distinct values across 12,000 scored candidates. Ties fall back to the prior relevance order.
- The graded tests used one answering model and one question set. A further test needs about 450 questions or a second corpus.
