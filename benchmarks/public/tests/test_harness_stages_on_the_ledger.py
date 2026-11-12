"""qa/harness.py on a synthetic benchmark: answers resume from the call log, scores read only the log, smoke items stay
out of the primary, the interval resamples the store-owning user, and a short search list is a real result."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import types
from pathlib import Path

import pytest
from conftest import RUNNER, rec, write_log

if not (RUNNER / "benchmarks" / "locomo" / "prompts.py").exists():
    pytest.skip("h2h, which harness imports, needs Mem0's runner checkout", allow_module_level=True)

import harness  # noqa: E402
import h2h  # noqa: E402
import qa.ledger as ledger  # noqa: E402
from qa.ledger import ANSWERER, Item  # noqa: E402

QS = [{"qid": f"q{i}", "user_id": f"u{i // 2}", "question": f"question {i}", "gold": "yes", "category": "c",
       "ask_after": None} for i in range(6)]


def fake_loader() -> types.ModuleType:
    mod = types.ModuleType("loaders.fakebench")
    mod.NAME, mod.TOPK, mod.LICENCE, mod.DATA_FILES = "Fake", 5, "none", []
    mod.__file__ = __file__  # setup hashes the loader file into config.json
    mod.questions = lambda: [dict(q) for q in QS]
    mod.answer_prompt = lambda q, mems: (f"system for {q['qid']}", f"{q['question']} with {len(mems)} memories")
    mod.judge = lambda q, answer: ("match", answer.strip() == q["gold"])
    mod.conversations = lambda: [(f"u{i}", [{"role": "Speaker 1", "content": f" turn {i}a "}, {"role": "Speaker 2", "content": " "},
                                            {"role": "Speaker 2", "content": f"turn {i}b"}]) for i in range(3)]
    return mod


@pytest.fixture
def bench(tmp_path, monkeypatch):
    """An out folder after retrieval: questions, config, predicted files and their manifest; q5 is a smoke item."""
    monkeypatch.setitem(sys.modules, "loaders.fakebench", fake_loader())
    monkeypatch.setattr(ledger, "SMOKE", tmp_path / "smoke.json")
    (tmp_path / "smoke.json").write_text('{"fakebench": ["q5"]}', encoding="utf-8")
    out = tmp_path / "out"
    manifest: dict = {}
    for arm in harness.ARMS:
        for q in QS:
            p = harness.pred_path(out, arm, q["qid"])
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(json.dumps({"results": [{"memory": "m"}]}).encode())
            manifest.setdefault(arm, {})[q["qid"]] = hashlib.sha256(p.read_bytes()).hexdigest()
    (out / "predicted" / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    (out / "questions.json").write_text(json.dumps({"qids": [q["qid"] for q in QS]}), encoding="utf-8")
    (out / "config.json").write_text(json.dumps({"limit": 0, "arms": harness.ARMS}), encoding="utf-8")
    a = argparse.Namespace(stage="score", bench="fakebench", out=out, limit=0, slots=2, port_base=0, bonferroni=4,
                           arm=None, pairs_with=[], store_from=None)
    mod, qs = harness.setup(a)
    return a, mod, qs


def answer(arm: str, qid: str, **kw) -> dict:
    q = QS[int(qid[1:])]
    return rec(f"answer {arm} {qid}", f"{q['question']} with 1 memories", system=f"system for {qid}", **kw)


def full_log(out, hippo: dict, bm25: dict) -> None:
    """One valid reply per (arm, qid) with the given text."""
    write_log(out / "calls-answer.jsonl", [answer(arm, qid, text=t) for arm, plan in (("hippo365", hippo), ("bm25", bm25))
                                           for qid, t in plan.items()])


def test_score_reads_the_log_leaves_smoke_out_and_lists_exhausted(bench):
    a, mod, qs = bench
    full_log(a.out, {"q0": "yes", "q1": "yes", "q2": "yes", "q3": "no", "q4": "yes", "q5": "yes"},
             {"q0": "no", "q3": "yes", "q4": "yes", "q5": "no"})
    with (a.out / "calls-answer.jsonl").open("a", encoding="utf-8") as f:  # q1 exhausted; q2 valid at its 2nd ask
        for r in [answer("bm25", "q1", cli="2.1.400 (Claude Code)")] * 3 + [
                answer("bm25", "q2", model="claude-opus-5", text="no"), answer("bm25", "q2")]:
            f.write(json.dumps(r) + "\n")
    (a.out / "answers.jsonl").write_text(json.dumps({"arm": "bm25", "qid": "q0", "answer": "yes"}) + "\n", encoding="utf-8")
    harness.stage_score(a, mod, qs)
    text = (a.out / "score.txt").read_text(encoding="utf-8")
    assert "hippo365  accuracy  80.0" in text and "bm25  accuracy  60.0" in text  # answers.jsonl is never read
    assert "PRIMARY hippo365 - bm25 all: +20.0 pp" in text and "n=5 over 3 units" in text
    assert "secondary, all items with the smoke items: +33.3 pp" in text and "n=6 over 3 units" in text
    assert "Bonferroni k=4, 98.75% interval: +20.0 pp" in text
    assert "smoke items left out of every primary: q5" in text
    assert "answers exhausted after 3 asks, scored wrong: 1" in text and "('bm25', 'q1'): cli" in text


def test_score_stops_while_an_answer_has_asks_left(bench):
    a, mod, qs = bench
    full_log(a.out, {q["qid"]: "yes" for q in QS}, {q["qid"]: "yes" for q in QS if q["qid"] != "q4"})
    with (a.out / "calls-answer.jsonl").open("a", encoding="utf-8") as f:
        f.write(json.dumps(answer("bm25", "q4", effort="low")) + "\n")
    with pytest.raises(SystemExit, match="answers: 1 of 12 not settled"):
        harness.stage_score(a, mod, qs)


def test_answer_resume_reuses_the_log_and_never_passes_three_asks(bench, monkeypatch):
    a, mod, qs = bench
    write_log(a.out / "calls-answer.jsonl", [answer("hippo365", "q0"), *[answer("hippo365", "q1", effort="low")] * 3,
                                             answer("hippo365", "q2", effort="low")])
    asked: list[str] = []

    class FakeClaude:
        def __init__(self, work, log, slots) -> None:
            self.cli = ANSWERER.cli

        def ask(self, system: str, user: str, *, effort: str, tag: str) -> dict:
            asked.append(tag)
            return answer(tag.split()[1], tag.split()[2])

    monkeypatch.setattr(harness, "Claude", FakeClaude)
    harness.stage_answer(a, mod, qs)
    assert sorted(asked) == sorted([f"answer hippo365 q{i}" for i in (2, 3, 4, 5)] + [f"answer bm25 q{i}" for i in range(6)])
    trail = [json.loads(line) for line in (a.out / "answers.jsonl").read_text(encoding="utf-8").splitlines()]
    assert {(r["qid"], r["asks"]) for r in trail if r["arm"] == "hippo365"} == {("q2", 2), ("q3", 1), ("q4", 1), ("q5", 1)}


def test_the_unit_is_the_user_unless_one_store_holds_every_question():
    assert harness.units(QS) == {q["qid"]: q["user_id"] for q in QS}
    one = [{**q, "user_id": "hotpot24"} for q in QS]
    assert harness.units(one) == {q["qid"]: q["qid"] for q in QS}


class Srv:
    arm = "hippo365"

    def __init__(self, n: int) -> None:
        self.n = n

    def search(self, user: str, query: str, limit: int) -> list[dict]:
        return [{"id": i, "memory": "m", "score": 1.0, "created_at": None} for i in range(self.n)]


def test_a_short_search_list_is_a_real_result_and_a_long_one_fails(tmp_path):
    assert len(harness.search_for(Srv(7), QS[0], 20, 30)) == 7
    with pytest.raises(RuntimeError, match="at most 20 expected"):
        harness.search_for(Srv(21), QS[0], 20, 30)
    with pytest.raises(RuntimeError, match="at most 7 expected"):  # memories from turns not yet stored
        harness.search_for(Srv(8), QS[0], 20, 7)
    harness.write_pred(tmp_path, "hippo365", QS[0], harness.search_for(Srv(7), QS[0], 20, 12), 20, 12)
    assert json.loads(harness.pred_path(tmp_path, "hippo365", "q0").read_text(encoding="utf-8"))["returned"] == 7


def test_h2h_answers_come_from_the_log_and_exhausted_ones_hold_none(tmp_path, monkeypatch):
    items = {("hippo365", 200, "conv0_q1"): (3, Item("answer hippo365 200 conv0_q1", "", "p1", ANSWERER, h2h.answer_of)),
             ("bm25", 200, "conv0_q1"): (3, Item("answer bm25 200 conv0_q1", "", "p2", ANSWERER, h2h.answer_of))}
    monkeypatch.setattr(h2h, "answer_prompts", lambda a: items)
    write_log(tmp_path / "calls-answer.jsonl", [rec("answer hippo365 200 conv0_q1", "p1", text="why\nANSWER: Paris"),
                                                *[rec("answer bm25 200 conv0_q1", "p2", effort="low")] * 3])
    got = h2h.all_answers(argparse.Namespace(logs=tmp_path))
    assert got[("hippo365", 200, "conv0_q1")]["answer"] == "Paris"
    assert got[("bm25", 200, "conv0_q1")]["answer"] is None and got[("bm25", 200, "conv0_q1")]["choice"].asks == 3


def test_h2h_primary_has_the_conversation_sensitivity_and_bonferroni_lines():
    diff = {f"conv{c}_q{i}": float((c + i) % 3 - 1) for c in range(4) for i in range(5)}
    ids = sorted(diff)
    lines = h2h.primary_lines("hippo365 - mem0 F1 all", diff, ids[:-1], ids, str, 2)
    assert lines[0].startswith("PRIMARY hippo365 - mem0 F1 all:") and "n=19 over 19 units" in lines[0]
    assert "n=20 over 20 units" in lines[1] and lines[2].startswith("  Bonferroni k=2, 97.50% interval:")
    assert "n=20 over 4 units" in h2h.paired(diff, ids, lambda q: q.split("_q")[0])


def test_full_context_shows_the_whole_chat_and_scores_paired_with_the_registered_run(bench, tmp_path):
    a, mod, qs = bench
    full_log(a.out, {q["qid"]: "yes" for q in QS}, {**{q["qid"]: "yes" for q in QS}, "q0": "no"})
    f = argparse.Namespace(stage="retrieve", bench="fakebench", out=tmp_path / "full", limit=0, slots=2, port_base=0,
                           bonferroni=None, arm="full", pairs_with=[a.out], store_from=None)
    mod, qs = harness.setup(f)
    harness.stage_ingest_retrieve(f, mod, qs)
    pred = json.loads(harness.pred_path(f.out, "full", "q2").read_text(encoding="utf-8"))
    assert [r["memory"] for r in pred["results"]] == ["Speaker 1: turn 1a", "Speaker 2: turn 1b"]  # oldest first, blank dropped
    assert (pred["returned"], pred["turns_visible"]) == (2, 3)
    assert json.loads((f.out / "config.json").read_text(encoding="utf-8"))["pairs_with"] == [str(a.out)]
    write_log(f.out / "calls-answer.jsonl", [rec(f"answer full {q['qid']}", f"{q['question']} with 2 memories",
                                                 system=f"system for {q['qid']}", text="no" if q["qid"] == "q1" else "yes")
                                             for q in QS])
    f.stage = "score"
    harness.stage_score(f, mod, qs)
    text = (f.out / "score.txt").read_text(encoding="utf-8")
    assert "the whole chat" in text and "full  accuracy  80.0  memories   2.0" in text and "PRIMARY" not in text
    assert "secondary hippo365 (100.0 in out) - full: +20.0 pp" in text and "n=5 over 3 units" in text
    assert "secondary bm25 (80.0 in out) - full:  +0.0 pp" in text
    assert "smoke items left out of every primary: q5" in text


@pytest.mark.parametrize("argv", [["ingest", "--arm", "full", "--pairs-with", "REG"],
                                  ["retrieve", "--arm", "full", "--pairs-with", "OUT"],
                                  ["ingest", "--arm", "hippo-emb"], ["ingest", "--pairs-with", "REG"],
                                  ["retrieve", "--arm", "hippo-emb", "--pairs-with", "REG", "--store-from", "REG"],
                                  ["ingest", "--arm", "hippo-best", "--pairs-with", "REG", "--store-from", "REG"]])
def test_an_extra_arm_needs_its_pair_and_a_new_folder(tmp_path, monkeypatch, argv):
    argv = [str(tmp_path / "registered") if x == "REG" else str(tmp_path) if x == "OUT" else x for x in argv]
    monkeypatch.setattr(sys, "argv", ["harness.py", *argv, "--bench", "fakebench", "--out", str(tmp_path)])
    with pytest.raises(SystemExit):
        harness.main()


def test_only_the_hippo_emb_arm_starts_its_server_with_embeddings(tmp_path):
    emb, plain = harness.server_args("hippo-emb", 1, tmp_path), harness.server_args("hippo365", 1, tmp_path)
    assert emb[emb.index("--arm") + 1] == "hippo" and emb[-2:] == ["--embeddings", "1"]
    assert "--embeddings" not in plain and plain[plain.index("--arm") + 1] == "hippo"


def test_a_memory_arm_prints_itself_minus_each_paired_arm(bench, tmp_path):
    a, mod, qs = bench
    full_log(a.out, {q["qid"]: "yes" for q in QS}, {**{q["qid"]: "yes" for q in QS}, "q0": "no", "q1": "no"})
    e = argparse.Namespace(stage="score", bench="fakebench", out=tmp_path / "emb", limit=0, slots=2, port_base=0,
                           bonferroni=None, arm="hippo-emb", pairs_with=[a.out], store_from=None)
    manifest = {}
    for q in QS:
        pth = harness.pred_path(e.out, "hippo-emb", q["qid"])
        pth.parent.mkdir(parents=True, exist_ok=True)
        pth.write_bytes(json.dumps({"results": [{"memory": "m"}]}).encode())
        manifest[q["qid"]] = hashlib.sha256(pth.read_bytes()).hexdigest()
    (e.out / "predicted" / "manifest.json").write_text(json.dumps({"hippo-emb": manifest}), encoding="utf-8")
    (e.out / "questions.json").write_text(json.dumps({"qids": [q["qid"] for q in QS]}), encoding="utf-8")
    (e.out / "config.json").write_text(json.dumps({"limit": 0, "arms": {"hippo-emb": "hippo"}}), encoding="utf-8")
    write_log(e.out / "calls-answer.jsonl", [answer("hippo-emb", q["qid"], text="no" if q["qid"] == "q0" else "yes")
                                             for q in QS])
    mod, qs = harness.setup(e)
    harness.stage_score(e, mod, qs)
    text = (e.out / "score.txt").read_text(encoding="utf-8")
    assert "hippo-emb  accuracy  80.0" in text and "top 5" in text
    assert "secondary hippo-emb - hippo365 (100.0 in out): -20.0 pp" in text
    assert "secondary hippo-emb - bm25 (60.0 in out): +20.0 pp" in text


def test_shards_split_the_users_and_record_each_once(tmp_path, monkeypatch):
    ports: list[int] = []

    class FakeServer:
        def __init__(self, arm, port, data, log, read_only=False) -> None:
            self.health = {"arm": arm}
            ports.append(port)

        def __enter__(self):
            return self

        def __exit__(self, *exc) -> None:
            pass

    monkeypatch.setattr(harness, "Server", FakeServer)
    monkeypatch.setattr(harness, "run_unit", lambda srv, mod, out, user, turns, qs, phase, gate, src:
                        {"user": user, "phase": "ingest", "turns": len(turns), "stored": len(turns), "questions": 0})
    users = {f"u{i}": [{"qid": f"q{i}"}] for i in range(7)}
    a = argparse.Namespace(out=tmp_path, shards=3, store_from=None)
    harness.run_arm(a, None, "hippo365", 9000, users, {u: [{}] for u in users}, "ingest")
    done = [json.loads(line)["user"] for line in (tmp_path / "ingest" / "hippo365" / "done.jsonl").read_text().splitlines()]
    assert sorted(done) == sorted(users) and sorted(ports) == [9000, 9001, 9002]
    harness.run_arm(a, None, "hippo365", 9000, users, {u: [{}] for u in users}, "ingest")  # all done: no server starts
    assert len(ports) == 3


def test_the_hippo_best_arm_adds_the_reranker_and_rank_score_to_the_embeddings():
    best = harness.server_args("hippo-best", 1, Path("d"), read_only=True)
    assert best[-6:] == ["--embeddings", "1", "--reranker-top-k", "50", "--rank-score", "--read-only"]
    assert harness.want_health("hippo-best", True) == {"arm": "hippo", "embeddings": True, "readOnly": True,
                                                       "rankScore": True, "rerankerTopK": 50}
    assert harness.want_health("hippo-emb", False) == {"arm": "hippo", "embeddings": True, "readOnly": False,
                                                       "rankScore": False, "rerankerTopK": 0}


class Fixed:
    """A server that returns the same results for every search; write= a file it writes into the user's store."""

    def __init__(self, arm: str, results: list[dict], data: Path | None = None, write: str = "") -> None:
        self.arm, self.results, self.data, self.write = arm, results, data, write

    def search(self, user: str, query: str, limit: int) -> list[dict]:
        if self.write:
            (harness.store_dir(self.data, user) / self.write).write_text("x", encoding="utf-8")
        return [dict(r) for r in self.results]


def old_store(data: Path, user: str) -> None:
    """A store whose one file is older than any search."""
    root = harness.store_dir(data, user)
    root.mkdir(parents=True)
    (root / "hippo.db").write_text("rows", encoding="utf-8")
    os.utime(root / "hippo.db", ns=(10**18, 10**18))


def test_a_replay_writes_the_new_arm_only_while_the_hippo_emb_search_gives_back_the_saved_file(tmp_path):
    src, out, data = tmp_path / "emb", tmp_path / "best", tmp_path / "data"
    saved = [{"id": "a", "memory": "m", "score": 0.5, "created_at": None}]
    old_store(data, "u0")
    harness.write_pred(src, "hippo-emb", QS[0], saved, 5, 3)
    mod, turns = fake_loader(), [{"role": "r", "content": "x"}]
    best = Fixed("hippo-best", [{"id": "b", "memory": "n", "score": 1.0, "created_at": None}])
    rec = harness.run_unit(best, mod, out, "u0", turns, [QS[0]], "retrieve", Fixed("hippo-emb", saved, data), src)
    assert rec["phase"] == "retrieve"
    assert json.loads(harness.pred_path(out, "hippo-best", "q0").read_text(encoding="utf-8"))["results"][0]["id"] == "b"
    moved = [{**saved[0], "score": 0.4}]
    with pytest.raises(RuntimeError, match="replay differs"):
        harness.run_unit(best, mod, out, "u0", turns, [QS[0]], "retrieve", Fixed("hippo-emb", moved, data), src)


def test_a_replay_stops_on_a_store_newer_than_the_search_or_one_the_replay_writes(tmp_path):
    src, out, data = tmp_path / "emb", tmp_path / "best", tmp_path / "data"
    saved = [{"id": "a", "memory": "m", "score": 0.5, "created_at": None}]
    old_store(data, "u0")
    harness.write_pred(src, "hippo-emb", QS[0], saved, 5, 3)
    mod, turns = fake_loader(), [{"role": "r", "content": "x"}]
    best = Fixed("hippo-best", saved)
    harness.run_unit(best, mod, out, "u0", turns, [QS[0]], "retrieve", Fixed("hippo-emb", saved, data, "x-shm"), src)
    with pytest.raises(RuntimeError, match="replay changed"):
        harness.run_unit(best, mod, out, "u0", turns, [QS[0]], "retrieve", Fixed("hippo-emb", saved, data, "new.db"), src)
    with pytest.raises(RuntimeError, match="changed after"):  # new.db is newer than the hippo-emb search
        harness.run_unit(best, mod, out, "u0", turns, [QS[0]], "retrieve", Fixed("hippo-emb", saved, data), src)
    with pytest.raises(RuntimeError, match="missing"):
        harness.run_unit(best, mod, out, "u1", turns, [QS[0]], "retrieve", Fixed("hippo-emb", saved, data), src)


def test_the_store_dir_is_the_servers_root_for_the_user(tmp_path):
    root = harness.store_dir(tmp_path, "dmr-000")
    assert root == tmp_path / f"dmr-000-{hashlib.sha256(b'dmr-000').hexdigest()[:10]}" / ".hippo"
    assert harness.store_dir(tmp_path, "a b/c").parent.name.startswith("a_b_c-")


def test_no_manifest_while_a_server_log_of_an_embeddings_arm_says_it_fell_back(bench, tmp_path, monkeypatch):
    a, mod, qs = bench
    monkeypatch.setattr(harness, "run_arm", lambda *args: None)
    monkeypatch.setattr(harness, "ARMS", {"hippo-emb": "hippo"})
    r = argparse.Namespace(**{**vars(a), "stage": "retrieve", "arm": "hippo-emb", "arms": {"hippo-emb": "hippo"},
                              "shards": 1, "out": tmp_path / "emb"})
    (r.out / "ingest" / "hippo-emb").mkdir(parents=True)
    (r.out / "ingest" / "hippo-emb" / "server.log").write_text("warn: hybrid search fell back to BM25 only: x\n",
                                                              encoding="utf-8")
    with pytest.raises(SystemExit, match="BM25 alone"):
        harness.stage_ingest_retrieve(r, mod, qs)
    assert not (r.out / "predicted" / "manifest.json").exists()


def test_a_replay_refuses_a_benchmark_that_asks_mid_history(bench, tmp_path, monkeypatch):
    a, mod, qs = bench
    monkeypatch.setattr(mod, "questions", lambda: [{**q, "ask_after": 1} for q in QS])
    r = argparse.Namespace(stage="retrieve", bench="fakebench", out=tmp_path / "best", limit=0, slots=2, port_base=0,
                           bonferroni=None, arm="hippo-best", pairs_with=[a.out], store_from=a.out)
    with pytest.raises(SystemExit, match="mid-history"):
        harness.setup(r)
