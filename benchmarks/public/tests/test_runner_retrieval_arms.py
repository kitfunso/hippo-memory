"""runner/run_retrieval.py (prereg Amendment 6 dated notes 5): a server counts as up only when it runs the arm's backend
with embeddings on exactly for hippo-emb, so no arm is retrieved with the wrong search."""
from __future__ import annotations

import io
import json

import pytest

import run_retrieval as rr


class Proc:
    def poll(self) -> None:
        return None

    def terminate(self) -> None:
        pass


OFF = {"readOnly": False, "rankScore": False, "rerankerTopK": 0}
BEST = {"arm": "hippo", "embeddings": True, "readOnly": False, "rankScore": True, "rerankerTopK": 50}


@pytest.mark.parametrize("arm, health, ok", [
    ("hippo-emb", {"arm": "hippo", "embeddings": True, **OFF}, True),
    ("hippo-emb", {"arm": "hippo", "embeddings": False, **OFF}, False),
    ("hippo365", {"arm": "hippo", "embeddings": False, **OFF}, True),
    ("hippo365", {"arm": "hippo", "embeddings": True, **OFF}, False),
    ("bm25", {"arm": "hippo", "embeddings": False, **OFF}, False),
    ("hippo-best", BEST, True),
    ("hippo-best", {**BEST, "embeddings": False}, False),  # the cross-encoder over a store with no vectors
    ("hippo-best", {**BEST, "rerankerTopK": 0}, False),
    ("hippo-best", {**BEST, "rankScore": False}, False),  # the runner's sort by score would undo the reranker
    ("hippo-emb", {"arm": "hippo", "embeddings": True, "readOnly": False}, False),  # a server too old to report them
])
def test_the_health_check_matches_the_arm_and_its_embeddings(monkeypatch, arm, health, ok):
    monkeypatch.setattr(rr.urllib.request, "urlopen", lambda url, timeout: io.BytesIO(json.dumps(health).encode()))
    if ok:
        rr.wait_health(1, Proc(), arm)
    else:
        with pytest.raises(SystemExit, match="is not the"):
            rr.wait_health(1, Proc(), arm)


def test_longmemeval_s_reads_the_runner_dataset_the_registered_run_read():
    assert rr.BENCH["longmemeval-s"] == ("lme", "longmemeval_s_cleaned.json")


def write_q(pred, name: str, uid: str, n: int = 200) -> None:
    hits = [{"memory": f"m{i}"} for i in range(n)]
    pred.joinpath(name).write_text(json.dumps({"user_id": uid, "retrieval": {"search_results": hits, "total_results": n}}),
                                   encoding="utf-8")


def test_a_user_with_a_retried_add_in_the_last_launch_is_redone_whole(tmp_path, monkeypatch):
    pred, log = tmp_path / "pred", tmp_path / "runner.log"
    pred.mkdir()
    for q, uid in (("q1", "u1"), ("q2", "u2"), ("q3", "u3")):
        write_q(pred, f"{q}.json", uid)
        write_q(pred, f"_ingestion_{q}.json", uid)
    log.write_text("\n=== launch 1\nADD attempt 1/5 failed (user=u3): reset\n"
                   "\n=== launch 2\nADD attempt 1/5 failed (user=u1): [WinError 64]\n"
                   "SEARCH attempt 1/5 failed (user=u2): Server disconnected\n", encoding="utf-8")
    deleted = []
    monkeypatch.setattr(rr.urllib.request, "urlopen", lambda req, timeout: deleted.append(req.full_url) or io.BytesIO(b"{}"))
    assert rr.drop_retried_users(pred, log, 1) == 1
    assert sorted(p.name for p in pred.iterdir()) == ["_ingestion_q2.json", "_ingestion_q3.json", "q2.json", "q3.json"]
    assert deleted == ["http://127.0.0.1:1/memories?user_id=u1"]


def test_the_check_keeps_a_retried_search_but_fails_a_retried_add(tmp_path):
    pred, log = tmp_path / "pred", tmp_path / "runner.log"
    pred.mkdir()
    write_q(pred, "q1.json", "u1")
    log.write_text("\n=== launch\nSEARCH attempt 1/5 failed (user=u1): Server disconnected\n", encoding="utf-8")
    assert rr.check(pred, ["q1"], [log], [], 0.0)["pass"]
    log.write_text("\n=== launch\nADD attempt 1/5 failed (user=u1): Server disconnected\n", encoding="utf-8")
    res = rr.check(pred, ["q1"], [log], [], 0.0)
    assert not res["pass"] and "runner log lines name a failure" in res["problems"][0]
    log.write_text("\n=== launch\nSEARCH failed after 5 attempts for user=u1\n", encoding="utf-8")
    assert not rr.check(pred, ["q1"], [log], [], 0.0)["pass"]


@pytest.mark.parametrize("bench, units, files, owners", [
    ("longmemeval-m", [{"q1", "gpt4_ab"}, {"q2"}], ["q1.json", "_ingestion_q1.json", "gpt4_ab.json", "_progress_q2.json"],
     [0, 0, 0, 1]),
    ("beam-1m", [{"1M_0", "1M_2"}, {"1M_1"}], ["1M_0_q3_abstention.json", "_ingestion_1M_1.json", "1M_2_q0_x_y.json"],
     [0, 1, 0]),
])
def test_a_resume_after_a_merge_moves_each_file_back_to_its_shard(tmp_path, bench, units, files, owners):
    src = tmp_path / f"predicted_{bench}"
    src.mkdir()
    for f in files:
        (src / f).write_text("{}", encoding="utf-8")
    assert rr.unmerge(bench, tmp_path, units) == len(files)
    assert not list(src.glob("*.json"))
    for f, k in zip(files, owners):
        assert (tmp_path / f"shard{k}" / f"predicted_{bench}" / f).exists()


def test_a_merged_file_no_shard_owns_stops_the_resume(tmp_path):
    src = tmp_path / "predicted_longmemeval-m"
    src.mkdir()
    (src / "q9.json").write_text("{}", encoding="utf-8")
    with pytest.raises(SystemExit, match="belongs to no shard"):
        rr.unmerge("longmemeval-m", tmp_path, [{"q1"}])


def rows(d, qid: str, memories: list[str]) -> None:
    d.mkdir(parents=True, exist_ok=True)
    res = [{"memory": m, "created_at": "2023-01-01", "score": 1.0} for m in memories]
    (d / f"{qid}.json").write_text(json.dumps({"retrieval": {"search_results": res}}), encoding="utf-8")


def test_hippo_best_may_reorder_the_first_100_but_must_show_rows_101_to_200_as_hippo_emb(tmp_path):
    emb = [f"m{i}" for i in range(200)]
    rows(tmp_path / "emb", "q", emb)
    rows(tmp_path / "ok", "q", emb[:100][::-1] + emb[100:])
    rows(tmp_path / "tail", "q", emb[:100] + emb[100:][::-1])
    rows(tmp_path / "set", "q", emb[:99] + [emb[150]] + emb[100:150] + [emb[99]] + emb[151:])
    assert rr.same_shown(tmp_path / "ok", tmp_path / "emb", ["q"]) == []
    assert rr.same_shown(tmp_path / "tail", tmp_path / "emb", ["q"]) == ["q"]
    assert rr.same_shown(tmp_path / "set", tmp_path / "emb", ["q"]) == ["q"]
    assert rr.same_shown(tmp_path / "none", tmp_path / "emb", ["q"]) == ["q"]
