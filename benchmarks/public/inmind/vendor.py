"""InMind's own code and data, imported from the pinned local clone; the repo carries no licence, so none is copied.

imlrz/InMind 5a2ab268: the 125 tasks and the fixed 47-session LME-s background (MIT, LongMemEval), each task's
timeline from evaluation/scripts/build_timeline.py, the answer prompt, and the binary judges' prompts and user payloads
from evaluation/scripts/build_judge_payloads.py. gpt-5-mini answers at max_completion_tokens 16,384 and judges at
4,096, with no temperature or top-p (Table 6; evaluation/README.md).
"""
from __future__ import annotations

import functools
import hashlib
import importlib.util
import json
import re
import sys
from pathlib import Path

sys.path[:0] = [str(Path(__file__).resolve().parents[1])]
from qa.openai_reasoning import EFFORT, ReasoningSettings  # noqa: E402,F401
from qa.vendor_pin import check  # noqa: E402

CLONE = Path.home() / "hippo-bench" / "vendor" / "InMind"
DATA = Path.home() / "hippo-bench" / "datasets" / "inmind"  # `git show` of the three data files at COMMIT
COMMIT = "5a2ab2686d3d5b832575f0288d41ecc93eab358b"
BLOBS = {  # git ls-tree at COMMIT
    "benchmark/dataset/inmind.jsonl": "46d945d3c32261139325ea22b1850e2a5fd8c7df",
    "evaluation/background/lme_s_background.jsonl": "f9dee3dbeb23eab5dce7f25ef73f2b5927f56226",
    "evaluation/background/manifest.json": "3835c98d8f3f06e63a73e0ca64c53f4570d58941",
    "evaluation/prompts/answer_system.txt": "8534722cec97bad249160a35b4c814cb855db2da",
    "evaluation/prompts/judge_naive.txt": "4808301d24c33d63571fdd532c56b15d28924cbe",
    "evaluation/prompts/judge_target_recall.txt": "67993f5ca74a1d40e29a96b5a3883b4dcf90bc1f",
    "evaluation/prompts/judge_application.txt": "4837b18fe80a8d842727293be3aff4e410c711cf",
    "evaluation/scripts/build_judge_payloads.py": "7e671eb14377f90a59a6b3139c6316d595d0df5d",
    "evaluation/scripts/build_timeline.py": "47afbe7df819d0090553920a5468064404d3f69e",
    "evaluation/scripts/validate_submission.py": "d653e062e7176c061d051f3869f90ff4c6febfb4",
}
SHA256 = {  # benchmark/dataset/SHA256SUMS and the manifest's sha256; manifest.json is its blob's bytes
    "inmind.jsonl": "4e27c56047d1f7c3eaf21ad5b6662f638f81a434034546be08b85e09876675a4",
    "lme_s_background.jsonl": "aef51e8a4e606a3ac5ceafdc64d875a7f1f41a051dafd68dce45f9c90d626da1",
    "manifest.json": "14d30226edf82c823b7438bd3943847c1127503204d637ef074f04d815898125",
}
SNAPSHOT = "gpt-5-mini-2025-08-07"  # "GPT-5-mini" in Table 6; the gpt-5-mini alias's one snapshot
ANSWERER = ReasoningSettings(SNAPSHOT, max_completion_tokens=16_384)
JUDGE = ReasoningSettings(SNAPSHOT, max_completion_tokens=4_096)
METRICS = ("naive", "target-recall", "application")  # Table 1's column order
TOPK = 10  # Table 11 (Mem0) and Table 12 (A-Mem): top-10 memories; hippo is a flat dense store like them


@functools.lru_cache(maxsize=1)
def scripts() -> dict:
    """build_timeline and build_judge_payloads from the clone, checked against their pins once."""
    check(CLONE, COMMIT, BLOBS)
    out = {}
    for name in ("build_timeline", "build_judge_payloads"):
        spec = importlib.util.spec_from_file_location(f"inmind_{name}", CLONE / "evaluation" / "scripts" / f"{name}.py")
        out[name] = mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
    return out


def data_file(name: str) -> Path:
    p = DATA / name
    if not p.exists() or hashlib.sha256(p.read_bytes()).hexdigest() != SHA256[name]:
        sys.exit(f"{p} is missing or not the released bytes: `git -C {CLONE} show {COMMIT}:<path> > {p}`")
    return p


@functools.lru_cache(maxsize=1)
def tasks() -> tuple[dict, ...]:
    rows = scripts()["build_timeline"].read_jsonl(data_file("inmind.jsonl"))
    if len(rows) != 125 or len({r["task_id"] for r in rows}) != 125:
        raise RuntimeError(f"{len(rows)} tasks, not the paper's 125 distinct task ids")
    return tuple(rows)


@functools.lru_cache(maxsize=1)
def background() -> tuple[list[dict], dict]:
    bt = scripts()["build_timeline"]
    return bt.read_jsonl(data_file("lme_s_background.jsonl")), json.loads(data_file("manifest.json").read_text("utf-8"))


def timeline(task: dict) -> list[dict]:
    """The task's turns in order: 47 sessions with the target pair at the end of session 9 (build_timeline)."""
    turns, manifest = background()
    tl = scripts()["build_timeline"].build_timeline(task, [dict(t) for t in turns], manifest)
    return [{"role": t["role"], "content": t["content"], "timestamp": None} for s in tl["sessions"] for t in s["turns"]]


def answer_system(context: str) -> str:
    """answer_system.txt with {context} replaced; the query is the user message (evaluation/README.md)."""
    scripts()
    return (CLONE / "evaluation" / "prompts" / "answer_system.txt").read_text(encoding="utf-8").replace("{context}", context)


def judge_system(metric: str) -> str:
    return scripts()["build_judge_payloads"].PROMPTS[metric].read_text(encoding="utf-8").rstrip()


def judge_user(metric: str, task: dict, result: dict) -> str:
    return scripts()["build_judge_payloads"].user_payload(metric, task, result)


def context(memories: list[str]) -> str:
    """The retrieved memories as the answerer sees them, one "- <memory>" line each in rank order."""
    return "\n".join(f"- {m}" for m in memories)


def verdict(text: str) -> int | None:
    """A judge reply's binary score: a JSON object {"score": 0 or 1, ...}, whole or in a ``` fence; else no verdict."""
    s = text.strip()
    if m := re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", s, re.S):
        s = m.group(1)
    try:
        data = json.loads(s)
    except ValueError:
        return None
    score = data.get("score") if isinstance(data, dict) else None
    return score if type(score) is int and score in (0, 1) else None
