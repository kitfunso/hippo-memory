"""stalebench/: the pinned release, the rebuilt Table 5 subsample, the reader's request and the attribution of hippo's
hits to statements (notes-2026-11-17-stalebench.md)."""
from __future__ import annotations

import json
import sys

import pytest
from conftest import PUBLIC

sys.path.insert(0, str(PUBLIC / "stalebench"))
import stale_vendor as v  # noqa: E402
from qa.vendor_pin import drift  # noqa: E402

needs_clone = pytest.mark.skipif(not (v.CLONE / ".git").exists(), reason="StaleBench's clone is not on this box")


def test_the_published_setup_is_pinned():
    assert (v.COMMIT, v.CONFIGS, v.N_FACTS, v.DEPTH, v.READ_K, v.READER, v.MAX_TOKENS) == (
        "724fccc1ec4caec10b937d7e63159b4f8da7e6e5", ("anchored", "anchor_free"), 150, 20, 5, "qwen2.5:14b", 32)


@needs_clone
def test_the_rebuilt_subsample_is_the_papers_stream():
    assert drift(v.CLONE, v.COMMIT, v.BLOBS) == []
    for c in v.CONFIGS:
        sub = v.subsample(c)
        assert (len(sub["events"]), len(sub["queries"])) == (329, 150)
        assert v.sidecar_drift(c) == []


@needs_clone
def test_the_paper_cache_gives_table_5s_cosine_cells_through_these_scorers():
    # the column mapping: cur@1 by id, by text, contamination@5 by text, qwen2.5:14b correct on the top 5
    m, rd, cache = v.module("metrics"), v.module("reader"), v.paper_cache()
    want = {"anchored": (0.460, 0.460, 0.973, 0.573), "anchor_free": (0.140, 0.140, 0.927, 0.427)}
    for c, cells in want.items():
        got = []
        for q, h in zip(v.subsample(c)["queries"], v.sidecar()["by_config"][c]["cosine-rag"]):
            r = m.score_ranking(list(dict.fromkeys(x["sid"] for x in h)), q["fact"], q["current"], (5,))
            r.update(m.score_texts([x["text"] for x in h], q["gold"], q["stale"], (5,)))
            p = rd.build_prompt([x["text"] for x in h[:v.READ_K]], q["question"])
            r.update(rd.score_answer(cache[v.cache_key(v.READER, p)]["text"], q["gold"], q["stale"]))
            got.append(r)
        means = tuple(round(sum(r[k] for r in got) / len(got), 3)
                      for k in ("current@1", "current@1_text", "contamination@5_text", "correct"))
        assert means == cells


@needs_clone
def test_the_reader_sends_ollamas_greedy_request_off_the_gpu(tmp_path):
    client = v.ollama_client(tmp_path, 4)
    sent = {}
    client._post = lambda url, body, headers, timeout=None: sent.update(url=url, body=body) or {"response": " A "}
    assert client.generate("p", v.MAX_TOKENS) == "A"
    assert sent == {"url": "http://localhost:11434/api/generate", "body": {
        "model": "qwen2.5:14b", "prompt": "p", "stream": False,
        "options": {"temperature": 0.0, "seed": 0, "num_predict": 32, "num_gpu": 0, "num_thread": 4}}}
    assert json.loads(next(tmp_path.glob("*.json")).read_text())["text"] == "A"


@needs_clone
def test_a_hit_is_its_statement_by_text_and_date():
    import stalebench_hippo as sh
    e = v.subsample("anchored")["events"][0]
    hit = {"memory": "user: " + e["text"], "created_at": sh.iso(e["t"]) + ".000Z"}
    assert sh.attributed("anchored", [hit]) == [{"sid": e["sid"], "text": e["text"], "created_at": hit["created_at"]}]
    with pytest.raises(RuntimeError, match="no statement of the stream"):
        sh.attributed("anchored", [{"memory": "user: not in the stream", "created_at": hit["created_at"]}])
    with pytest.raises(RuntimeError, match="no unused statement"):
        sh.attributed("anchored", [hit, hit])
