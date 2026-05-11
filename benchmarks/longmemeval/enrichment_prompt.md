# LongMemEval session signal-extraction prompt (F10 Track 3)

Use as the user-message body for each subagent invocation. Append the
batch JSON (a JSON array of session objects) verbatim below the prompt.

---

You are a signal extractor. You'll receive a JSON array of conversation sessions. For each session, output ONE JSON object with these fields:

```
{
  "session_id": "<copy from input>",
  "confidence": "stale" | "inferred" | "observed" | "verified",
  "kind": "episodic" | "semantic" | "procedural",
  "schema_fit": 0.0-1.0,
  "strength": 0.0-2.0,
  "outcome_positive": 0 | 1 | 2 | 3,
  "outcome_negative": 0 | 1 | 2 | 3
}
```

Rubrics:

**CONFIDENCE** — tier values are the keys of `CONFIDENCE_WEIGHT` in `src/rerankers/features.ts` (verified=1.30, observed=1.10, inferred=0.90, stale=0.70). Mismatched tier names fall back to weight 1.0 and lose discrimination.

- `"verified"`: session contains a definitive, externally-verifiable fact OR a precisely-stated user/assistant claim with no hedging (e.g. "The Eiffel Tower is in Paris", "I'll do X tomorrow", "the API returned 200", official policy, scheduled event).
- `"observed"`: session contains a clearly-stated user/assistant preference, recurring habit, or direct observation that is true at the time of the session but not externally verifiable (e.g. "I like pizza", "I usually run on Tuesdays", "the build took longer than expected").
- `"inferred"`: session contains a partial / hedged / multi-step claim that requires reading between the lines ("might", "probably", "I think", inferred plan, paraphrased intent).
- `"stale"`: session is clearly time-bound and the time has passed, OR the claim was contradicted later in the session.

**KIND**

- `"episodic"`: specific past event with a who/what/when/where ("yesterday I met X", "the meeting on Tuesday").
- `"semantic"`: general fact or preference ("I like pizza", "Python uses indentation").
- `"procedural"`: a how-to / step-list / recipe ("to deploy, run X then Y").

**SCHEMA_FIT** (0..1) — how well does the session match a single coherent topic / schema?

- 0.0: random / multi-topic / nothing memorable.
- 0.5: mixed but recognisable.
- 1.0: tight single-topic, clearly memorable.

**STRENGTH** (0..2) — how confidently and specifically is the central claim stated?

- 0.0: vague aside.
- 1.0: typical conversational claim.
- 2.0: precise, repeated, with evidence.

**OUTCOME_POSITIVE / OUTCOME_NEGATIVE** (0..3) — did the session reference outcomes (success/failure, did/didn't work)? Count each side independently. 0 if no outcome language.

Return ONLY a JSON array of these objects, one per input session. No prose, no markdown fences. Output goes directly into a file.

---

(Append the batch JSON below this line in each subagent prompt.)
