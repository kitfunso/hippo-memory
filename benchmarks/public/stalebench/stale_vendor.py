"""StaleBench's own code and released data, imported from the pinned clone (notes-2026-11-17-stalebench.md).

thenexuslab/stalebench-release 724fccc1 (v1.2.2, the camera-ready sync): the release's anchored and anchor-free test
files, from which Table 5's 150-fact subsample is rebuilt; the scorers (metrics.score_ranking, metrics.score_texts,
reader.score_answer), the reader prompt (reader.build_prompt), Graphiti's statement date (systems.statement_time), the
ollama client (llm.OllamaClient) and the shipped reader cache. Apache-2.0 code, CC0 data; still imported, never copied.
"""
from __future__ import annotations

import functools
import gzip
import importlib
import json
import re
import sys
from pathlib import Path

sys.path[:0] = [str(Path(__file__).resolve().parents[1])]
from qa.vendor_pin import check  # noqa: E402

CLONE = Path.home() / "hippo-bench" / "vendor" / "stalebench-release"
COMMIT = "724fccc1ec4caec10b937d7e63159b4f8da7e6e5"
BLOBS = {  # git ls-tree at COMMIT
    "stalebench/__init__.py": "6b6983a3bb2bd9f3457ec5f6923acf05e66e0a8c",
    "stalebench/alias.py": "02ed704ba429fb3749d03f97d9250823f2c90425",
    "stalebench/bm25.py": "74cda786a93b0877919fbc3fd04e452f4dee39c1",
    "stalebench/llm.py": "f4a53739626ceb6ce4a69ee7e0f76ec903d6d689",
    "stalebench/metrics.py": "1a682cbea7bd3c4c8b08cf55f23b0e10601fe43f",
    "stalebench/policies.py": "2392d0f174556ecaa070d03cc164368ce44c2137",
    "stalebench/reader.py": "5b69843f14618b902a84ecdf2c60df3e47919733",
    "stalebench/systems.py": "93015f839e830e1e702c122e1186a09dc9d0a5a4",
    "stalebench/templama.py": "3cd9c100655a15e36dd7959d01e3bcac1d299c13",
    "release/statements_anchored_test.jsonl": "c7e2f07770256f8303f781ba486fab5881a2e77b",
    "release/queries_anchored_test.jsonl": "c4bf5258b738cfbc3c8bd8e9661576460925bac0",
    "release/key_anchored_test.jsonl": "3b098087e29238f5b567dfcdba4294c97281eec0",
    "release/statements_anchor_free_test.jsonl": "ad320647770d20050d77683b8d6fcdeb5839a6d5",
    "release/queries_anchor_free_test.jsonl": "e8cdc9c21b447ec248338df193e847c08ed0c157",
    "release/key_anchor_free_test.jsonl": "71d23f8803ba5ee86b8c37d43f1cbd3ceb1ab06c",
    "release/llm_cache.jsonl.gz": "b9541355041afad4dfcd3ed7f0329706bfe86d7f",
    "results/stalebench_systems_langmem_qwen.contexts.json": "b0a0b28ae88fd8827d4d67301e32bd6d19950e7a",
}
CONFIGS = ("anchored", "anchor_free")  # Table 5's two blocks: alias_p 0 and 1
N_FACTS = 150  # run_systems.py --limit default: test[:150]
DEPTH = 20  # run_systems._DEPTH, the top_k every wrapped system is searched with
READ_K = 5  # run_sysreader._TOPK: the reader sees the top 5
READER = "qwen2.5:14b"  # Table 5's reader, through OllamaClient
MAX_TOKENS = 32  # run_reader._batch, which run_sysreader calls
YEAR0 = 2010  # templama._YEAR0


def module(name: str):
    """stalebench.<name> from the clone, checked once against the pin."""
    _pinned()
    mod = importlib.import_module(f"stalebench.{name}")
    if not Path(mod.__file__).resolve().is_relative_to(CLONE.resolve()):
        sys.exit(f"stalebench.{name} resolves to {mod.__file__}, not the pinned clone")
    return mod


@functools.lru_cache(maxsize=1)
def _pinned() -> None:
    check(CLONE, COMMIT, BLOBS)
    if str(CLONE) not in sys.path:
        sys.path.insert(0, str(CLONE))


def _jsonl(rel: str) -> list[dict]:
    _pinned()
    return [json.loads(x) for x in (CLONE / rel).read_text(encoding="utf-8").splitlines() if x.strip()]


def run_values(subject: str, relation: str, texts: list[str]) -> list[str]:
    """Each anchored statement's value, read back through the relation's templates with the subject verbatim."""
    out = []
    for text in texts:
        got = set()
        for tpl in module("templama").RELATIONS[relation]["statements"]:
            pat = re.escape(tpl).replace(re.escape("{s}"), re.escape(subject)).replace(re.escape("{v}"), "(.+)")
            if m := re.fullmatch(pat, text):
                got.add(m.group(1))
        if len(got) != 1:
            raise RuntimeError(f"{text!r}: {len(got)} template readings")
        out.append(got.pop())
    return out


@functools.lru_cache(maxsize=None)
def subsample(config: str) -> dict:
    """Table 5's stream for one config: the first 150 test facts, as build_instance(test[:150]) gives them.

    The release is build_instance(test) with opaque ids; facts keep their order (q<i> is fact i) and per-fact random
    draws come first-come, so the first 150 facts' statements, templates and order within a year are the same in
    both builds. Ids become run_systems' f<i>:<run>; t is re-derived over the 150-fact stream, (year - 2010) +
    1e-4 * position, as build_instance stamps it. Values come from the anchored texts (a run's value is the same in
    every config)."""
    keys = _jsonl(f"release/key_{config}_test.jsonl")[:N_FACTS]
    qs = _jsonl(f"release/queries_{config}_test.jsonl")[:N_FACTS]
    if not [k["query_id"] for k in keys] == [q["query_id"] for q in qs] == [f"test/{config}/q{i}" for i in range(N_FACTS)]:
        raise RuntimeError(f"{config}: queries and keys are not q0..q{N_FACTS - 1} in order")
    sid_of = {s: f"f{i}:{r}" for i, k in enumerate(keys) for r, s in enumerate(k["fact_ids"])}
    rows = [s for s in _jsonl(f"release/statements_{config}_test.jsonl") if s["id"] in sid_of]
    if len(rows) != len(sid_of):
        raise RuntimeError(f"{config}: {len(sid_of)} statement ids in the key, {len(rows)} in the stream")
    events = [{"sid": sid_of[s["id"]], "text": s["text"], "year": s["year"], "t": (s["year"] - YEAR0) + 1e-4 * n}
              for n, s in enumerate(rows)]
    values = anchored_values()
    queries = []
    for i, (k, q) in enumerate(zip(keys, qs)):
        vals = values[k["fact_key"]]
        cur = {r for r, s in enumerate(k["fact_ids"]) if s in set(k["current_ids"])}
        if {vals[r] for r in cur} != {k["gold_value"]} or vals[-1] != k["gold_value"]:
            raise RuntimeError(f"{k['query_id']}: the current runs do not hold the gold value")
        stale = module("reader").stale_values_of(list(enumerate(vals)), k["gold_value"])
        queries.append({"qid": f"{config}-q{i:03d}", "fact": f"f{i}", "question": q["question"], "current": cur,
                        "gold": k["gold_value"], "stale": stale, "subject": k["subject"]})
    return {"events": events, "queries": queries}


@functools.lru_cache(maxsize=1)
def anchored_values() -> dict[str, list[str]]:
    """fact key -> the value of each run, in run order, from the anchored test stream."""
    text = {s["id"]: s["text"] for s in _jsonl("release/statements_anchored_test.jsonl")}
    rel = {q["query_id"]: q["relation"] for q in _jsonl("release/queries_anchored_test.jsonl")}
    return {k["fact_key"]: run_values(k["subject"], rel[k["query_id"]], [text[s] for s in k["fact_ids"]])
            for k in _jsonl("release/key_anchored_test.jsonl")}


def sidecar() -> dict:
    """The paper's own contexts file for this subsample (the LangMem qwen2.5:14b run): ladder hits and labels."""
    _pinned()
    return json.loads((CLONE / "results" / "stalebench_systems_langmem_qwen.contexts.json").read_text(encoding="utf-8"))


def sidecar_drift(config: str) -> list[str]:
    """Where the rebuilt stream or labels differ from the paper's sidecar for this config, or [] when they agree."""
    sc, sub = sidecar(), subsample(config)
    out = []
    if sc["config"]["n_test_facts"] != N_FACTS or not sc["config"]["subsampled"]:
        out.append(f"sidecar config {sc['config']}")
    if [q["gold"] for q in sub["queries"]] != sc["gold"]:
        out.append("gold values differ")
    if [q["stale"] for q in sub["queries"]] != sc["stale_values"]:
        out.append("stale values differ")
    ev = {e["sid"]: (e["text"], e["year"]) for e in sub["events"]}
    for pol, per_q in sc["by_config"][config].items():
        for hits in per_q:
            for h in hits:
                if h.get("t") is not None and (h["text"], h["t"]) != ev.get(h["sid"]):
                    out.append(f"{pol} {h['sid']}: {h['text']!r} {h['t']} against {ev.get(h['sid'])}")
    return out[:5]


@functools.lru_cache(maxsize=1)
def paper_cache() -> dict[str, dict]:
    """release/llm_cache.jsonl.gz by key: every reader answer the paper used, keyed as OllamaClient keys it."""
    _pinned()
    with gzip.open(CLONE / "release" / "llm_cache.jsonl.gz", "rt", encoding="utf-8") as fh:
        return {r["key"]: r for r in map(json.loads, fh)}


def cache_key(model: str, prompt: str, max_tokens: int = MAX_TOKENS) -> str:
    """llm._BaseClient._path's hash, so a prompt finds the paper's cached answer."""
    import hashlib
    return hashlib.md5(f"{model}\x1f{max_tokens}\x1f{prompt}".encode()).hexdigest()


def ollama_client(cache_dir: Path, num_thread: int):
    """The vendor's OllamaClient with its own request plus two options that keep this box usable: num_gpu 0 (another
    session's training run holds the GPU) and a thread cap. Greedy decoding, seed 0 and num_predict are unchanged."""
    llm = module("llm")

    class Client(llm.OllamaClient):
        def _complete(self, prompt: str, max_tokens: int):
            r = self._post(f"{self.host}/api/generate",
                           {"model": self.model, "prompt": prompt, "stream": False,
                            "options": {"temperature": 0.0, "seed": 0, "num_predict": max_tokens,
                                        "num_gpu": 0, "num_thread": num_thread}},
                           headers={}, timeout=600)
            return r["response"].strip(), 0.0

    return Client(model=READER, cache_dir=str(cache_dir))
