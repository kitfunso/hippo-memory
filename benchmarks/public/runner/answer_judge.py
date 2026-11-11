"""Answer and judge saved retrieval with Mem0's runner code (prereg Amendment 6, group A): LongMemEval and BEAM.

The runner's own functions run unchanged, `apply_longmemeval_answerer_judge_to_saved_result` for LongMemEval and
`process_question` for BEAM, over its saved `--predict-only` files, with two adapters in place of its LLM clients:
the answerer is Claude Sonnet 5 at medium effort through claude_llm.py, the judge gpt-5.6-sol at medium effort
through codex_judge.py. Every call is logged, and every saved result must be reproducible from the call logs alone:
`verify` runs the same code again with no calls allowed and compares (prereg Amendment 5 items 2 and 3). Each prompt
takes the first valid reply among its first 3 asks, counted across every run, under the frozen manifest (qa/ledger.py).
Usage (runner venv): python -I answer_judge.py {run,verify} --bench B --pred hippo365=DIR --pred bm25=DIR --out DIR
"""
from __future__ import annotations

import argparse
import asyncio
import contextvars
import hashlib
import json
import logging
import random
import re
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
PUBLIC = HERE.parent
RUNNER = Path.home() / "hippo-bench" / "memory-benchmarks"
sys.path[:0] = [str(HERE), str(PUBLIC / "mem0"), str(PUBLIC / "qa"), str(PUBLIC), str(RUNNER)]
import codex_judge  # noqa: E402
import h2h  # noqa: E402
from benchmarks.beam import run as beam  # noqa: E402
from benchmarks.beam.prompts import BEAM_JUDGE_SYSTEM_PROMPT  # noqa: E402
from benchmarks.common.llm_client import LLMClient  # noqa: E402
from benchmarks.common.mem0_client import format_search_results  # noqa: E402
from benchmarks.longmemeval import run as lme  # noqa: E402
from claude_llm import Claude  # noqa: E402
from qa.ledger import ANSWERER, JUDGE, Choice, Item, Ledger, require, trail  # noqa: E402

# codex_judge's preamble asks for "the JSON object only", which would turn LongMemEval's yes/no judge into JSON.
# Same no-tools wording, format left to the prompt; one value for every arm and benchmark.
codex_judge.PREAMBLE = ("You are a grading function. Do NOT use any tool. Do NOT read, open, view or write any file. "
                        "Everything you need is in this message. Reply in exactly the format the instructions ask for.\n\n")
LME_CUTOFFS, BEAM_CUTOFFS = [200, 10], [100]
BEAM_SIZES = {"beam-100k": "100K", "beam-500k": "500K", "beam-1m": "1M", "beam-10m": "10M"}
BENCHES = ("longmemeval-s", "longmemeval-m", *BEAM_SIZES)
CTX: contextvars.ContextVar[tuple[str, str]] = contextvars.ContextVar("ctx")  # (arm, question id) of the running task
sha = h2h.sha


class MissingReply(RuntimeError):
    """Replay needs a logged reply that is not there."""


class Exhausted(RuntimeError):
    """An answer with no valid reply in its 3 asks: its question scores wrong on every metric (prereg Amendment 6
    revision 1 item 5)."""


def kind_of(bench: str) -> str:
    return "beam" if bench in BEAM_SIZES else "lme"


def parse_json_reply(text: str):
    """A judge reply as the runner reads structured output (llm_client.py:285-293), after a whole-reply code fence is removed."""
    t = text.strip()
    fenced = h2h.FENCE.fullmatch(t)
    try:
        v = json.loads(fenced[1] if fenced else t)
        if isinstance(v, dict) and len(v) == 1 and "final" in v:
            inner = v["final"]
            v = json.loads(inner) if isinstance(inner, str) else inner if isinstance(inner, (dict, list)) else v
        return v
    except ValueError:
        return None


def number(v: object, key: str, kind: type) -> bool:
    if not isinstance(v, dict) or key not in v:
        return False
    try:
        kind(v[key])
    except (ValueError, TypeError):
        return False
    return True


def valid_structured(system: str, v: object) -> bool:
    """A reply the runner could use. Where it would score 0 or -1 for a reply with no score or index, this asks again."""
    if v is None:
        return False
    if system == BEAM_JUDGE_SYSTEM_PROMPT:
        return number(v, "score", float)
    if system.startswith("Align the event"):
        return number(v, "index", int)
    if system.startswith("Extract events"):
        return isinstance(v, list) or (isinstance(v, dict) and any(isinstance(v.get(k), list) for k in ("events", "facts", "result")))
    return True


def yes_no_of(text: str) -> tuple[bool, str] | None:
    """LongMemEval's verdict as the runner parses it, or None for a reply with neither word, which is asked again."""
    if text.strip() and re.search(r"\b(yes|no)\b", text.lower()):
        return LLMClient._parse_yes_no_judgment(None, text), text.strip()  # type: ignore[arg-type]
    return None


class Backend:
    """Claude and the codex judge behind the call logs: each prompt gets the first valid reply among its first 3 asks,
    counted across every run (qa/ledger.py). A replay (live=False) never asks."""

    def __init__(self, out: Path, slots_answer: int, slots_judge: int, live: bool) -> None:
        self.live, self.lock = live, threading.Lock()
        self.logs = {"answer": out / "calls-answer.jsonl", "judge": out / "calls-judge.jsonl"}
        self.ledgers = {role: Ledger(p) for role, p in self.logs.items()}
        self.trace: dict[tuple[str, str], list[dict]] = {}
        if live:
            self.llm = {"answer": Claude(out / "claude-work", self.logs["answer"], slots_answer),
                        "judge": codex_judge.CodexJudge(self.logs["judge"], slots_judge)}
            require(self.llm["answer"], ANSWERER)
            require(self.llm["judge"], JUDGE)

    def _settle(self, role: str, item: Item) -> Choice:
        c = self.ledgers[role].settle(item, self.llm[role]) if self.live else self.ledgers[role].choose(item)
        if c.status == "open":
            raise MissingReply(f"{role} reply for {item.tag} {item.key[1]} not in {self.logs[role].name}")
        with self.lock:
            self.trace.setdefault(CTX.get(), []).append({"role": role, "tag": item.tag, "prompt_sha256": sha(item.user),
                                                          "tokens_in": h2h.tokens_in(c.record or {}), **trail(c)})
        return c

    def answer(self, system: str, user: str) -> str:
        arm, qid = CTX.get()
        c = self._settle("answer", Item(f"answer {arm} {qid} {sha(system)[:8]}", system, user, ANSWERER))
        if c.status == "exhausted":
            raise Exhausted(f"answer {arm} {qid}: {'; '.join(c.rejected)}")
        return c.value.strip()

    def structured(self, system: str, user: str):
        """The first usable reply in 3 asks. With none, the runner's own value after unreadable replies, {}
        (llm_client.py:308), which its code scores as a failed step; no verdict is made up."""
        arm, qid = CTX.get()

        def usable(text: str):
            v = parse_json_reply(text)
            return v if valid_structured(system, v) else None

        c = self._settle("judge", Item(f"judge {arm} {qid} {sha(system)[:8]}", system, user, JUDGE, usable))
        return c.value if c.status == "valid" else {}

    def yes_no(self, user: str) -> tuple[bool, str]:
        """LongMemEval's yes/no judge, asked again on a reply with neither word. With none in 3 asks the item is no,
        as the runner counts such a reply."""
        arm, qid = CTX.get()
        c = self._settle("judge", Item(f"judge {arm} {qid} {sha('')[:8]}", "", user, JUDGE, yes_no_of))
        return c.value if c.status == "valid" else (False, "")


class Answerer:
    """The runner's LLMClient.generate over Claude."""

    def __init__(self, be: Backend, pool: ThreadPoolExecutor) -> None:
        self.be, self.pool = be, pool

    async def generate(self, system: str, user: str, temperature: float = 0, max_tokens: int = 4096) -> str:
        ctx = contextvars.copy_context()
        return await asyncio.get_running_loop().run_in_executor(self.pool, ctx.run, self.be.answer, system, user)


class Judge:
    """The runner's LLMClient.generate_structured and judge_yes_no over the codex judge."""

    def __init__(self, be: Backend, pool: ThreadPoolExecutor) -> None:
        self.be, self.pool = be, pool

    async def generate_structured(self, system: str, user: str, response_format=None, temperature: float = 0,
                                  max_tokens: int = 4096):
        ctx = contextvars.copy_context()
        return await asyncio.get_running_loop().run_in_executor(self.pool, ctx.run, self.be.structured, system, user)

    async def judge_yes_no(self, prompt: str) -> tuple[bool, str]:
        ctx = contextvars.copy_context()
        return await asyncio.get_running_loop().run_in_executor(self.pool, ctx.run, self.be.yes_no, prompt)


class SavedSearch:
    """Stands in for Mem0Client in process_question: the search returns the saved retrieval."""

    def __init__(self, results: list[dict]) -> None:
        self.results = results

    async def search(self, query: str, user_id: str, top_k: int = 200, score_debug: bool = False) -> list[dict]:
        return self.results


def pred_files(d: Path) -> dict[str, Path]:
    return {p.stem: p for p in d.glob("*.json") if not p.name.startswith("_")}


def load_pred(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


_BEAM_DATA: dict[str, list] = {}


def beam_question(saved: dict) -> dict:
    size = saved["chat_size"]
    if size not in _BEAM_DATA:
        _BEAM_DATA[size] = json.loads((RUNNER / "datasets" / "beam" / f"beam_{size}.json").read_text(encoding="utf-8"))
    q = beam.extract_probing_questions(_BEAM_DATA[size][saved["conversation_idx"]])[saved["question_type_idx"]]
    if q.get("question_text", q.get("question", "")) != saved["question"]:
        raise RuntimeError(f"{saved['question_id']}: the dataset's question differs from the saved retrieval's")
    return q


async def evaluate(bench: str, saved: dict, be: Backend, pool: ThreadPoolExecutor) -> dict:
    """The runner's result for one saved question, its cutoff_results filled by the runner's own code. A question
    with an exhausted prompt names it under "exhausted"; one with an exhausted answer has no cutoff_results."""
    ans, jdg = Answerer(be, pool), Judge(be, pool)
    try:
        if kind_of(bench) == "lme":
            res = json.loads(json.dumps(saved))
            await lme.apply_longmemeval_answerer_judge_to_saved_result(res, ans, jdg, LME_CUTOFFS)  # type: ignore[arg-type]
        else:
            res = await beam.process_question(
                question_data=beam_question(saved), qi=saved["question_type_idx"], chat_size=saved["chat_size"],
                conv_idx=saved["conversation_idx"], user_id=saved["user_id"],
                mem0=SavedSearch(saved["retrieval"]["search_results"]), answerer=ans, judge_llm=jdg,
                cutoffs=BEAM_CUTOFFS, top_k=200, predict_only=False, logger=logging.getLogger("beam"),
                conversation_meta={"conversation_id": saved.get("conversation_id", "")})
    except Exhausted as e:
        return {"question_type": saved["question_type"], "exhausted": [str(e)]}
    res.pop("retrieval", None)
    if spent := [t["tag"] for t in be.trace.get(CTX.get(), []) if t["status"] == "exhausted"]:
        res["exhausted"] = spent  # absent when none, so results saved before this rule still verify
    return res


def slim(saved: dict) -> dict:
    return {k: v for k, v in saved.items() if k != "retrieval"}


def same_result(a: dict, b: dict) -> bool:
    return json.dumps(a, sort_keys=True, ensure_ascii=False) == json.dumps(b, sort_keys=True, ensure_ascii=False)


def pick(bench: str, arms: dict[str, Path], limit: int) -> list[str]:
    """Question ids common to every arm. For a smoke run, a seeded handful, with one event-ordering question for BEAM."""
    ids = sorted(set.intersection(*(set(pred_files(d)) for d in arms.values())))
    if not limit:
        return ids
    rng = random.Random(1)
    rng.shuffle(ids)
    chosen = ids[:limit]
    if kind_of(bench) == "beam":
        eo = [i for i in ids if i.endswith("_event_ordering")]
        if eo and not any(c.endswith("_event_ordering") for c in chosen):
            chosen[-1] = eo[0]
    return sorted(chosen)


def check_retrieval(arm: str, pred: Path, ids: list[str]) -> str:
    """The arm's retrieval check, if its retrieval ran here, must have passed and still match the files: no answer is
    made on retrieval that lost an add or a search (the integrity gate, as prereg Amendment 5)."""
    cp = pred.parent / "retrieval-check.json"
    if not cp.exists():
        return "no retrieval-check.json (retrieval from another run, e.g. Lane R)"
    chk = json.loads(cp.read_text(encoding="utf-8"))
    files = pred_files(pred)
    manifest = hashlib.sha256("\n".join(f"{i}:{hashlib.sha256(files[i].read_bytes()).hexdigest()}" for i in sorted(ids)).encode()).hexdigest()
    if not chk.get("pass") or chk.get("manifest_sha256") != manifest:
        sys.exit(f"{arm}: retrieval check did not pass or the files changed since ({cp})")
    return "retrieval check passed, manifest matches"


def check_inputs(out: Path, arms: dict[str, Path], ids: list[str]) -> None:
    """The retrieval files this run answers, pinned on first use: a changed file stops the run."""
    pin = out / "inputs.json"
    now = {arm: {i: sha(pred_files(d)[i].read_text(encoding="utf-8")) for i in ids} for arm, d in arms.items()}
    if not pin.exists():
        pin.write_text(json.dumps({"arms": {a: str(d) for a, d in arms.items()}, "files": now}), encoding="utf-8")
        return
    old = json.loads(pin.read_text(encoding="utf-8"))["files"]
    for arm in arms:
        bad = [i for i in ids if old.get(arm, {}).get(i) != now[arm][i]]
        if bad:
            sys.exit(f"{len(bad)} retrieval files of {arm} differ from the ones this run started with, e.g. {bad[0]}; use a new --out")


def results_on_file(out: Path) -> dict:
    recs = h2h.records(out / "results.jsonl", lambda r: (r["arm"], r["qid"]))
    return recs


def verify(bench: str, arms: dict[str, Path], out: Path, ids: list[str]) -> dict:
    """Every saved result, made again from the call logs alone: same prompts, same replies, same result, or stop."""
    recs = results_on_file(out)
    be = Backend(out, 1, 1, live=False)
    pool = ThreadPoolExecutor(4)
    bad = []

    async def one(rec: dict) -> None:
        arm, qid = rec["arm"], rec["qid"]
        saved = load_pred(pred_files(arms[arm])[qid])
        CTX.set((arm, qid))
        try:
            again = await evaluate(bench, saved, be, pool)
        except MissingReply as e:
            bad.append(f"{arm} {qid}: {e}")
            return
        if not same_result(again, rec["result"]) or rec["pred_sha256"] != sha(pred_files(arms[arm])[qid].read_text(encoding="utf-8")):
            bad.append(f"{arm} {qid}: differs from the result rebuilt from the call logs")

    async def go() -> None:
        for rec in recs.values():
            if rec["qid"] in ids:
                await one(rec)

    asyncio.run(go())
    if bad:
        sys.exit(f"verify: {len(bad)} of {len(recs)} saved results do not match the call logs, e.g. {bad[0]}")
    print(f"verify: {len(recs)} saved results match the call logs", flush=True)
    return recs


def run(bench: str, arms: dict[str, Path], out: Path, a: argparse.Namespace) -> None:
    ids = pick(bench, arms, a.smoke)
    out.mkdir(parents=True, exist_ok=True)
    if not a.smoke:  # a smoke run answers a subset, which the manifest does not cover
        for arm, d in arms.items():
            check_retrieval(arm, d, ids)
    check_inputs(out, arms, ids)
    done =verify(bench, arms, out, ids) if (out / "results.jsonl").exists() else {}
    jobs = [(arm, qid) for qid in ids for arm in arms if (arm, qid) not in done]
    random.Random(4).shuffle(jobs)  # arms interleaved, so a slow or limited stretch hits every arm alike
    be = Backend(out, a.answer_slots, a.judge_slots, live=True)
    pool = ThreadPoolExecutor(a.tasks + 8)
    failed: list[str] = []
    print(f"{len(jobs)} questions to answer and judge, {len(done)} already done", flush=True)

    async def one(arm: str, qid: str, sem: asyncio.Semaphore, wl: asyncio.Lock, n: list[int]) -> None:
        async with sem:
            CTX.set((arm, qid))
            p = pred_files(arms[arm])[qid]
            try:
                res = await evaluate(bench, load_pred(p), be, pool)
            except Exception as e:  # named below and retried by a rerun; the other questions still land
                failed.append(f"{arm} {qid}: {type(e).__name__}: {e}")
                return
            rec = {"arm": arm, "qid": qid, "pred_sha256": sha(p.read_text(encoding="utf-8")), "result": res,
                   "calls": be.trace.get((arm, qid), [])}
            async with wl:
                with (out / "results.jsonl").open("a", encoding="utf-8") as f:
                    f.write(json.dumps(rec, ensure_ascii=False) + "\n")
                n[0] += 1
                if n[0] % 25 == 0:
                    print(f"{n[0]}/{len(jobs)}", flush=True)

    async def go() -> None:
        sem, wl, n = asyncio.Semaphore(a.tasks), asyncio.Lock(), [0]
        await asyncio.gather(*(one(arm, qid, sem, wl, n) for arm, qid in jobs))

    asyncio.run(go())
    if failed:
        sys.exit(f"{len(failed)} of {len(jobs)} questions failed; rerun to retry them:\n" + "\n".join(failed[:20]))
    verify(bench, arms, out, ids)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("stage", choices=("run", "verify"))
    ap.add_argument("--bench", required=True, choices=BENCHES)
    ap.add_argument("--pred", action="append", required=True, metavar="ARM=DIR", help="an arm's predicted_* directory")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--smoke", type=int, default=0, help="only N seeded questions per arm; never scored")
    ap.add_argument("--tasks", type=int, default=24, help="questions in flight")
    ap.add_argument("--answer-slots", type=int, default=10, help="concurrent claude processes")
    ap.add_argument("--judge-slots", type=int, default=codex_judge.DEFAULT_SLOTS, help="concurrent codex processes")
    a = ap.parse_args()
    arms = {s.split("=", 1)[0]: Path(s.split("=", 1)[1]) for s in a.pred}
    if a.stage == "verify":
        verify(a.bench, arms, a.out, pick(a.bench, arms, a.smoke))
    else:
        run(a.bench, arms, a.out, a)


if __name__ == "__main__":
    main()
