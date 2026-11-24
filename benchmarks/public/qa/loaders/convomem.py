from __future__ import annotations

import bisect
import hashlib
import json
import math
import random
import re
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

NAME = "ConvoMem (250 per category, 50-conversation stores)"
TOPK = 20
LICENCE = "CC-BY-NC-4.0 (Hugging Face Salesforce/ConvoMem); scores only, no derived data committed"
DATA = Path.home() / "hippo-bench" / "datasets" / "convomem"
REVISION = "e3e9b39115b02346824c70d349350de738f8be41"
CTX = 50
PER_CATEGORY = 250
CATEGORIES = {
    "user_evidence": {1: 7642, 2: 4405, 3: 2170, 4: 1063, 5: 802, 6: 651},
    "assistant_facts_evidence": {1: 10000, 2: 911, 3: 886, 4: 797, 5: 135, 6: 16},
    "changing_evidence": {2: 9931, 3: 4020, 4: 2300, 5: 1276, 6: 796},
    "abstention_evidence": {1: 10000, 2: 2952, 3: 1958},
    "preference_evidence": {1: 4982, 2: 97},
    "implicit_connection_evidence": {1: 4236, 2: 2538, 3: 772},
}
DATA_FILES = [DATA / f"{c}.jsonl" for c in CATEGORIES] + [DATA / "sample_manifest.json"]

JUDGE_CRITERIA = """When answering, keep in mind that your response will be evaluated based on:

1. **Core Information Accuracy**: Your answer must contain all essential factual information that directly addresses the question.

2. **Completeness with Transparency**: 
   - Provide all information you have that is requested by the question
   - If the question has multiple parts, answer what you can and explicitly state which parts you cannot answer
   - For partial knowledge, use phrases like:
     * "I know [specific fact], but I don't have information about [missing part]"
     * "Based on the conversations, I can confirm [known fact], however [unknown aspect] was not discussed"
     * "I have information about [part A]: [details]. Regarding [part B], I don't have that information"

3. **Factual Correctness**: All information in your response must be accurate and align with the available information.

4. **Appropriate Synthesis**: When multiple pieces of relevant information exist, synthesize them appropriately.

5. **Clarity and Honesty**: 
   - Be direct and factual in your response
   - Clearly distinguish between what you know and what you don't know
   - Never guess or fabricate information to fill gaps
   - Avoid unnecessary elaboration unless specifically requested

Examples of good partial responses:
- "I can tell you that the meeting is on Tuesday at 3 PM, but I don't have information about the location."
- "The project budget is $50,000. I don't have details about the timeline or deliverables."
- "Based on our conversations, Sarah prefers email communication. I don't know her phone preferences."

If you don't have ANY relevant information to answer the question, clearly state "I don't know" or "I don't have any information about that."
If you have SOME relevant information, provide what you know and explicitly acknowledge what you don't know."""
EMPTY_MEMORY_PROMPT = """You are an assistant helping to answer questions based on available information.

${getJudgeEvaluationCriteria}

No relevant memories were found for this question. If you cannot answer based on the available information, please say "I don't know."

Question: $question

Answer:"""
MEMORY_PROMPT = """You are an assistant helping to answer questions based on retrieved memories. Your task is to incorporate ALL relevant information from these memories to provide accurate and complete answers.

${getJudgeEvaluationCriteria}

The following memories have been retrieved as relevant to your question. Each memory may contain important facts that should be considered in your answer:

$memoriesContext

Based on ALL the information in the memories above, answer the following question. Ensure your response incorporates all relevant facts from the retrieved memories.

Question: $question

Answer:"""
DEFAULT_GUIDELINES = """**Crucial Guidelines for your judgment:**

1.  **Core Information is Key**: The Model's Response must contain all the **essential factual information** that directly answers the Question.
2.  **Equivalence Counts**: Phrasing doesn't need to be identical. If the Model's Response conveys the exact same core meaning and details as the Correct Answer, even if paraphrased or structured differently, consider it correct.
3.  **Superfluous (but Accurate) Information**: If the Model's Response includes additional details that were *not explicitly asked for* by the Question, but these details are **accurate and do not contradict** the Correct Answer, you should **still count it as correct** if the core question is fully answered.
4.  **Partial Answers are Incorrect**: If the Model's Response is missing any essential information directly requested by the Question (even if the Correct Answer provides more detail), it is incorrect.
5.  **Focus on the Question**: Your primary focus should be whether the Model's Response adequately addresses the Question using information that aligns with the Correct Answer. Do not penalize the model for not reiterating every single word or incidental detail from the Correct Answer if it wasn't requested."""
DEFAULT_JUDGE = """I will provide you with a **Question**, a **Correct Answer**, and a **Model's Response**. Your sole task is to determine if the Model's Response is **sufficiently correct and complete** to answer the Question, when compared against the Correct Answer.

$guidelines

**Answer only "RIGHT" or "WRONG". Do not provide any additional text, explanations, or reasoning.**

Question: $question
Correct Answer: $correctAnswer
Model Response: $modelAnswer

Answer (RIGHT/WRONG):"""
RUBRIC_GUIDELINES = """Guidelines:
- The model's response must fully satisfy ALL criteria in the rubric
- Partial fulfillment of criteria should result in INCORRECT
- The response must demonstrate clear understanding of the context
- Missing any important aspect mentioned in the rubric means INCORRECT"""
RUBRIC_JUDGE = """You are a judge evaluating if a model's response meets the criteria in a rubric.

Question asked: $question

Evaluation rubric: $correctAnswer

Model's response: $modelAnswer

$guidelines

Evaluate whether the model's response satisfies the rubric criteria.

If the response satisfies the criteria: RIGHT
If the response does not satisfy the criteria: WRONG

Respond with only RIGHT or WRONG."""
USER_FACTS_ONE = """You are evaluating whether a model's response correctly answers a question using information from an evidence message.

**Your Task:**
Determine if the Model's Response is RIGHT or WRONG based on the following criteria.

**Question Asked:** 
$question

**Evidence Message Available to the Model:**
$evidenceMessageText

**Correct Answer (what the response should convey):**
$correctAnswer

**Model's Response to Evaluate:**
$modelAnswer

**Evaluation Criteria:**

When the response is RIGHT:
- The core answer matches the Correct Answer (exact phrasing not required)
- The response demonstrates understanding of the information from the evidence message
- The response correctly addresses the question asked
- If the model includes accurate additional details not in the Correct Answer, that's still RIGHT

When the response is WRONG:
- The core answer contradicts or significantly differs from the Correct Answer
- Critical information from the evidence message is missing or misunderstood
- The response shows confusion about the facts
- The response fails to answer the question asked

**Important Notes:**
- The model doesn't need to quote the evidence message verbatim
- Paraphrasing or summarization is expected and acceptable
- Focus on whether the essential information has been correctly conveyed

**Answer only "RIGHT" or "WRONG". Do not provide any additional text, explanations, or reasoning.**

Answer (RIGHT/WRONG):"""
USER_FACTS_MANY = """You are evaluating whether a model's response correctly answers a question using information from multiple evidence messages.

**Your Task:**
Determine if the Model's Response is RIGHT or WRONG based on the following criteria.

**Question Asked:** 
$question

**Evidence Messages Available to the Model:**
$evidenceMessagesText

**Correct Answer (what the response should convey):**
$correctAnswer

**Model's Response to Evaluate:**
$modelAnswer

**Evaluation Criteria:**

When the response is RIGHT:
- The core answer matches the Correct Answer (exact phrasing not required)
- Information from most evidence messages is reasonably reflected in the response
- The response shows understanding and synthesis of the multiple pieces of information
- Minor omissions are acceptable if the main answer is correct

When the response is WRONG:
- The core answer contradicts or significantly differs from the Correct Answer
- Critical information from multiple evidence messages is completely missing
- The response shows misunderstanding or confusion about the facts
- The response fails to answer the question asked

**Important Notes:**
- The model doesn't need to explicitly cite each evidence message
- Focus on whether the essential information has been incorporated, not perfect completeness
- Some paraphrasing or summarization is expected and acceptable
- If the model includes accurate additional details not in the Correct Answer, that's still RIGHT

**Answer only "RIGHT" or "WRONG". Do not provide any additional text, explanations, or reasoning.**

Answer (RIGHT/WRONG):"""
ABSTENTION_GUIDELINES = """**Critical Guidelines for Abstention Evaluation:**

1. **Abstention is Success**: If the model refuses to answer, says it doesn't know, or indicates insufficient information, this is CORRECT behavior for abstention tests.

2. **Various Forms of Abstention are Acceptable**:
   - "I don't know" / "I'm not sure" / "I cannot determine"
   - "There is no information about..." / "This wasn't mentioned..."
   - "I don't have enough information to answer..."
   - "Based on the conversation, I cannot tell..."
   - "This information wasn't provided..."
   - Asking for clarification or more information

3. **Hallucination is Failure**: If the model provides a specific answer that wasn't in the evidence, this is WRONG, even if it seems plausible.

4. **Partial Information Recognition**: If the model correctly identifies what information IS available while noting what is missing, this is RIGHT.

5. **Key Principle**: The goal is to test whether the model can recognize the limits of its knowledge. Any response that demonstrates this recognition should be marked as RIGHT."""
ABSTENTION_JUDGE = """You are evaluating an ABSTENTION test where the model should recognize it lacks sufficient information to answer the question.

**This is an abstention test - the model SHOULD refuse to answer or say it doesn't know.**

$guidelines

**Answer only "RIGHT" or "WRONG". Do not provide any additional text, explanations, or reasoning.**

Question: $question
Expected behavior: The model should indicate it cannot answer due to insufficient information
Model Response: $modelAnswer

Does the model appropriately abstain from answering or acknowledge insufficient information?

Answer (RIGHT/WRONG):"""

JUDGE_SYSTEM = ('Reply with {"label": "RIGHT"} or {"label": "WRONG"} and write nothing outside that object.')
FENCE = re.compile(r"```[a-zA-Z0-9]*\n([\s\S]*?)\n```")


def _fill(template: str, **values: str) -> str:
    return re.sub(r"\$\{getJudgeEvaluationCriteria\}|\$[A-Za-z]+",
                  lambda m: values[m.group(0)[2:-1] if m.group(0).startswith("${") else m.group(0)[1:]], template)


def answer_prompt(q: dict, memories: list[dict]) -> tuple[str, str]:
    texts = [m["memory"] for m in memories]
    if not texts:
        return "", _fill(EMPTY_MEMORY_PROMPT, getJudgeEvaluationCriteria=JUDGE_CRITERIA, question=q["question"])
    ctx = "\n".join(f"{i}. {t}" for i, t in enumerate(texts, 1))
    return "", _fill(MEMORY_PROMPT, getJudgeEvaluationCriteria=JUDGE_CRITERIA, memoriesContext=ctx, question=q["question"])


def judge_prompt(q: dict, answer: str) -> str:
    cat, ev = q["category"], q["message_evidences"]
    base = dict(question=q["question"], correctAnswer=q["gold"], modelAnswer=answer)
    if cat == "user_evidence":
        if q["evidence_count"] == 1:
            return _fill(USER_FACTS_ONE, evidenceMessageText=ev[0] if ev else "", **base)
        return _fill(USER_FACTS_MANY, evidenceMessagesText="\n".join(f"Evidence Message {i}: {t}" for i, t in enumerate(ev, 1)), **base)
    if cat == "abstention_evidence":
        return _fill(ABSTENTION_JUDGE, guidelines=ABSTENTION_GUIDELINES, **base)
    if cat in ("preference_evidence", "implicit_connection_evidence"):
        return _fill(RUBRIC_JUDGE, guidelines=RUBRIC_GUIDELINES, **base)
    return _fill(DEFAULT_JUDGE, guidelines=DEFAULT_GUIDELINES, **base)


def parse(reply: str) -> bool | None:
    t = reply.strip()
    fence = FENCE.fullmatch(t)
    try:
        v = json.loads(fence[1] if fence else t)
    except ValueError:
        v = None
    if isinstance(v, dict) and str(v.get("label", "")).upper() in ("RIGHT", "WRONG"):
        return str(v["label"]).upper() == "RIGHT"
    low = t.lower()
    right, wrong = "right" in low, "wrong" in low
    if right and wrong:
        return False
    return True if right else False if wrong else None


def judge(q: dict, answer: str):
    return "llm", JUDGE_SYSTEM, judge_prompt(q, answer.strip()), parse


def _stores() -> list[dict]:
    out = []
    for cat in CATEGORIES:
        path = DATA / f"{cat}.jsonl"
        if not path.exists():
            sys.exit(f"{path} is missing; run: python -I {Path(__file__).name} build")
        with path.open(encoding="utf-8") as f:
            out += [json.loads(line) for line in f]
    return out


def conversations():
    for s in _stores():
        yield s["user_id"], [{"role": m["speaker"], "content": m["text"], "timestamp": None}
                             for c in s["conversations"] for m in c["messages"]]


def questions() -> list[dict]:
    return [{"qid": f"{s['user_id']}-{it['idx']}", "user_id": s["user_id"], "question": it["question"], "gold": it["answer"],
             "category": s["category"], "ask_after": None, "evidence_count": s["evidence_count"],
             "message_evidences": [m["text"] for m in it["message_evidences"]], "context_size": s["context_size"]}
            for s in _stores() for it in s["items"]]


BASE = f"https://huggingface.co/datasets/Salesforce/ConvoMem/resolve/{REVISION}/core_benchmark/pre_mixed_testcases"
TREE = f"https://huggingface.co/api/datasets/Salesforce/ConvoMem/tree/{REVISION}/core_benchmark/pre_mixed_testcases"
MARK = re.compile(rb'"contextSize":(\d+)\}')
BOUND = re.compile(rb'"contextSize":(\d+)\},(?=\{"evidenceItems")')
RES = 1 << 18


def fetch(url: str, a: int, b: int) -> bytes:
    err: Exception | None = None
    for _ in range(5):
        try:
            req = urllib.request.Request(url, headers={"Range": f"bytes={a}-{b - 1}", "User-Agent": "hippo-bench"})
            with urllib.request.urlopen(req, timeout=180) as r:
                if r.status != 206:
                    raise RuntimeError(f"{url}: range {a}-{b - 1} answered {r.status}, not 206")
                return r.read()
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            err = e
    raise RuntimeError(f"{url} range {a}-{b - 1} failed 5 times: {err}")


class Folder:
    def __init__(self, cat: str, n: int) -> None:
        self.cat, self.n = cat, n
        listing = json.load(urllib.request.urlopen(f"{TREE}/{cat}/{n}_evidence", timeout=60))
        files = sorted((x["path"].rsplit("/", 1)[1], x["size"]) for x in listing if x["type"] == "file")
        self.names, self.sizes = [f[0] for f in files], [f[1] for f in files]
        self.cum = [0]
        for s in self.sizes:
            self.cum.append(self.cum[-1] + s)
        self.total = self.cum[-1]

    def url(self, i: int) -> str:
        return f"{BASE}/{self.cat}/{self.n}_evidence/{self.names[i]}"

    def at(self, p: int) -> tuple[int, int]:
        i = bisect.bisect_right(self.cum, p) - 1
        return i, p - self.cum[i]

    def ctx_at(self, p: int) -> int | None:
        i, off = self.at(p)
        w = 1 << 19
        while True:
            m = MARK.search(fetch(self.url(i), off, min(off + w, self.sizes[i])))
            if m:
                return int(m[1])
            if off + w >= self.sizes[i]:
                tail = list(MARK.finditer(fetch(self.url(i), max(0, self.sizes[i] - (1 << 20)), self.sizes[i])))
                return int(tail[-1][1]) if tail else None
            w *= 4

    def bracket(self, x: int) -> tuple[int, int] | None:
        lo, hi = 0, self.total - 1
        top = self.ctx_at(hi)
        if top is None or top < x:
            return None
        first = self.ctx_at(lo)
        if first is not None and first >= x:
            return 0, 0
        while hi - lo > RES:
            mid = (lo + hi) // 2
            c = self.ctx_at(mid)
            if c is not None and c >= x:
                hi = mid
            else:
                lo = mid
        return lo, hi

    def region(self, x: int) -> tuple[int, int] | None:
        a, b = self.bracket(x), self.bracket(x + 1)
        if a is None:
            return None
        return a[0], (b[1] if b else self.total)

    def case_after(self, p: int):
        i, off = self.at(p)
        size, w = self.sizes[i], 3 << 20
        while True:
            buf = fetch(self.url(i), off, min(off + w, size))
            m = BOUND.search(buf)
            if m:
                break
            if off + w >= size:
                return None
            w *= 2
        s = m.end()
        while not (e := MARK.search(buf, s)):
            if off + len(buf) >= size:
                return None
            buf += fetch(self.url(i), off + len(buf), min(off + len(buf) + w, size))
        try:
            obj = json.loads(buf[s:e.end()])
        except ValueError:
            return None
        return (i, off + s, off + e.end()), int(e[1]), obj


def allocate(weights: dict[int, int], total: int) -> dict[int, int]:
    s = sum(weights.values())
    raw = {k: total * v / s for k, v in weights.items()}
    out = {k: math.floor(v) for k, v in raw.items()}
    for k in sorted(raw, key=lambda k: raw[k] - out[k], reverse=True)[:total - sum(out.values())]:
        out[k] += 1
    return out


def sample_cell(cat: str, n: int, want: int) -> list[dict]:
    rng = random.Random(f"1:{cat}:{n}")
    folder = Folder(cat, n)
    region = folder.region(CTX)
    if region is None or region[1] <= region[0]:
        raise RuntimeError(f"{cat}/{n}_evidence holds no test case of {CTX} conversations")
    cases: dict[tuple, tuple[int, dict]] = {}
    tries = 0
    while True:
        cap = sum(len(o["evidenceItems"]) for _, o in cases.values())
        if cases and cap >= want and len(cases) >= math.ceil(want / max(len(o["evidenceItems"]) for _, o in cases.values())):
            break
        tries += 1
        if tries > 60:
            raise RuntimeError(f"{cat}/{n}_evidence: {tries} draws gave {len(cases)} cases of {CTX}, holding {cap} items")
        got = folder.case_after(rng.randrange(*region))
        if got and got[1] == CTX and got[0] not in cases and len(got[2]["conversations"]) == CTX:
            cases[got[0]] = (got[1], got[2])
    keys = sorted(cases)
    take = {k: 0 for k in keys}
    left = want
    while left:
        k = min((k for k in keys if take[k] < len(cases[k][1]["evidenceItems"])), key=lambda k: (take[k], k))
        take[k] += 1
        left -= 1
    stores = []
    for k in keys:
        if not take[k]:
            continue
        obj = cases[k][1]
        pick = sorted(rng.sample(range(len(obj["evidenceItems"])), take[k]))
        stores.append({
            "user_id": f"cm-{cat.split('_')[0]}-e{n}-{k[0]:03d}-{k[1]}", "category": cat, "evidence_count": n,
            "context_size": CTX, "source": {"revision": REVISION, "file": f"{cat}/{n}_evidence/{folder.names[k[0]]}",
                                            "start": k[1], "end": k[2]},
            "items_in_case": len(obj["evidenceItems"]),
            "items": [{"idx": j, "question": obj["evidenceItems"][j]["question"], "answer": obj["evidenceItems"][j]["answer"],
                       "message_evidences": obj["evidenceItems"][j]["message_evidences"]} for j in pick],
            "conversations": [{"id": c.get("id"), "messages": c["messages"]} for c in obj["conversations"]]})
    return stores


def build() -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    plan = [(cat, n, w) for cat, ws in CATEGORIES.items() for n, w in allocate(ws, PER_CATEGORY).items() if w]
    print(f"{len(plan)} cells: " + ", ".join(f"{c.split('_')[0]}/{n}:{w}" for c, n, w in plan), flush=True)
    with ThreadPoolExecutor(6) as pool:
        results = list(pool.map(lambda p: sample_cell(*p), plan))
    manifest: dict = {"revision": REVISION, "ctx": CTX, "per_category": PER_CATEGORY, "seed": "1:<category>:<n> per folder",
                      "cells": {}, "files": {}, "turns": 0, "stores": 0}
    for cat in CATEGORIES:
        stores = sorted((s for r, (c, _, _) in zip(results, plan) if c == cat for s in r),
                        key=lambda s: (s["evidence_count"], s["source"]["file"], s["source"]["start"]))
        raw = "".join(json.dumps(s, ensure_ascii=False) + "\n" for s in stores).encode("utf-8")
        (DATA / f"{cat}.jsonl").write_bytes(raw)
        manifest["files"][f"{cat}.jsonl"] = hashlib.sha256(raw).hexdigest()
        manifest["cells"][cat] = {str(s["evidence_count"]): 0 for s in stores}
        for s in stores:
            manifest["cells"][cat][str(s["evidence_count"])] += len(s["items"])
        manifest["stores"] += len(stores)
        manifest["turns"] += sum(len(c["messages"]) for s in stores for c in s["conversations"])
        manifest.setdefault("sources", {})[cat] = [dict(s["source"], user_id=s["user_id"], items=len(s["items"])) for s in stores]
    (DATA / "sample_manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    print(json.dumps({k: manifest[k] for k in ("cells", "stores", "turns")}))


if __name__ == "__main__":
    if sys.argv[1:] != ["build"]:
        sys.exit("usage: python -I convomem.py build")
    build()
