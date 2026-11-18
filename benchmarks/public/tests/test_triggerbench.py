"""triggerbench/: TriggerBench's pinned code and Base data, the messages its Mem0 runner sends, its few-shot GPT-4o judge
on the wire and through the ledger, and tab:main_results' columns (notes-2026-11-17-meme-triggerbench.md)."""
from __future__ import annotations

import json
import sys
import types

import pytest
from conftest import PUBLIC, write_log

sys.path.insert(0, str(PUBLIC / "triggerbench"))
import triggerbench_hippo as th  # noqa: E402
import triggerbench_vendor as v  # noqa: E402
from qa import openai_llm as ol  # noqa: E402
from qa.ledger import hash16  # noqa: E402
from qa.vendor_pin import drift  # noqa: E402

needs_clone = pytest.mark.skipif(not (v.CLONE / ".git").exists(), reason="TriggerBench's clone is not on this box")
SHOTS = [{"role": "user", "content": "ex"}, {"role": "assistant", "content": '{"verdict": "YES", "reason": "r"}'}]


def test_the_published_setup_is_pinned():
    assert (v.COMMIT, v.GEN, v.GEN_SNAPSHOT, v.FOUR_O, v.TOPK, v.JUDGE_MAX_TOKENS) == (
        "9e2185c3d071f73c195196ba1859631898017c8d", "gpt-4.1", "gpt-4.1-2025-04-14", "gpt-4o-2024-08-06", 6, 256)
    assert v.ANSWERER == ol.Settings("gpt-4.1", temperature=0.6, max_tokens=1024)
    assert v.A_MAN.model == "gpt-4.1-2025-04-14"  # the ledger takes a reply only from the snapshot the paper's alias had


@needs_clone
def test_the_clone_is_the_pinned_code_and_holds_the_papers_1265_tasks():
    assert drift(v.CLONE, v.COMMIT, v.BLOBS) == []
    es = v.entries()
    assert len(es) == 1265 and len({v.qid(e) for e in es}) == 1265
    count = {k: sum(e["variant"] == k for e in es) for k in v.VARIANTS}
    assert count == {"positive_clean": 488, "positive_overloaded": 488, "negative_clean": 289}
    smoke = [e for e in es if v.qid(e) in th.SMOKE]
    assert sorted(e["category"] for e in smoke) == sorted(v.CATEGORIES) and len(smoke) == 5


@needs_clone
def test_the_answer_is_the_message_pair_mem0_evals_runner_sends(monkeypatch, tmp_path):
    m, seen = v.code().mem0, {}
    e = next(x for x in v.entries() if v.qid(x) == "tb-nc-seed_b01")

    class Store:
        def add(self, batch, user_id):
            seen.setdefault("added", []).extend(batch)

        def search(self, query, filters, top_k):
            seen["search"] = (query, top_k)
            return {"results": [{"memory": "m1"}, {"memory": "m2"}]}
    fake = types.ModuleType("mem0")
    fake.Memory = types.SimpleNamespace(from_config=lambda cfg: Store())
    monkeypatch.setitem(sys.modules, "mem0", fake)
    monkeypatch.setattr(m, "_build_mem0_config", lambda **k: {})
    monkeypatch.setattr(m.tempfile, "mkdtemp", lambda **k: str(tmp_path))
    monkeypatch.setattr(m.shutil, "rmtree", lambda *a, **k: None)
    sent = []
    client = types.SimpleNamespace(complete_chat=lambda messages, max_tokens, temperature:
                                   sent.append((messages, max_tokens, temperature)) or "r")
    m._run_one_mem0(e, client, 0.6, v.TOPK, 40, e["category"])
    q = next(q for q in th.questions() if q["qid"] == "tb-nc-seed_b01")
    system, user = v.answer_messages(e["category"], ["m1", "m2"], q["question"])
    assert sent == [([{"role": "system", "content": system}, {"role": "user", "content": user}], 1024, 0.6)]
    assert seen["search"] == (q["question"], 6)
    turns = dict(th.conversations())["tb-nc-seed_b01"]
    assert [{"role": t["role"], "content": t["content"]} for t in turns] == seen["added"]


def test_answers_and_judges_send_what_triggerbench_sends(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    spend = tmp_path / "spend"
    answer = ol.OpenAIChat(tmp_path / "a.jsonl", v.ANSWERER, spend=spend)
    assert json.loads(answer._body("s", "u")) == {"model": "gpt-4.1", "temperature": 0.6, "max_tokens": 1024,
                                                  "messages": [{"role": "system", "content": "s"},
                                                               {"role": "user", "content": "u"}]}
    js = ol.Settings(v.FOUR_O, temperature=0.0, max_tokens=256, shots=json.dumps(SHOTS))
    judge = ol.OpenAIChat(tmp_path / "j.jsonl", js, spend=spend)
    assert json.loads(judge._body("s", "u")) == {"model": "gpt-4o-2024-08-06", "temperature": 0.0, "max_tokens": 256,
                                                 "messages": [{"role": "system", "content": "s"}, *SHOTS,
                                                              {"role": "user", "content": "u"}]}
    assert (answer.pool, judge.pool) == ("big", "big") and ol.PRICES["gpt-4.1"] == (2.00, 8.00)
    assert js.cli.endswith(f" shots={hash16(json.dumps(SHOTS))}") and "shots" not in ol.Settings(v.FOUR_O).cli


def test_a_verdict_is_valid_only_as_yes_or_no():
    assert v.verdict('```json\n{"verdict": "yes", "reason": "r"}\n```') == "YES"
    assert v.verdict('{"verdict": "NO"}') == "NO"
    assert v.verdict('{"verdict": "MAYBE"}') is None and v.verdict('{"verdict": 1}') is None and v.verdict("x") is None


def record(user: str, text: str) -> dict:
    cli = ol.Settings(v.FOUR_O, temperature=0.0, max_tokens=256, shots=json.dumps(SHOTS)).cli
    return {"tag": "t", "sys": hash16("s"), "user": hash16(user), "effort": v.EFFORT, "cli": cli, "event": "ok",
            "models": [v.FOUR_O], "text": text, "usage": {}, "ts": 0.0}


def test_the_judge_client_reads_the_first_valid_reply_lists_open_calls_and_raises_on_none(tmp_path):
    write_log(tmp_path / f"{hash16('s' + chr(10) + json.dumps(SHOTS))}.jsonl", [
        record("u1", "nope"), record("u1", '{"verdict": "NO"}'), *(record("u3", "x") for _ in range(3))])
    client = v.LedgerJudge(tmp_path, "t", live=False, slots=1)

    def ask(user: str, max_tokens: int = 256) -> str:
        return client.complete_chat([{"role": "system", "content": "s"}, *SHOTS, {"role": "user", "content": user}],
                                    max_tokens=max_tokens, temperature=0.0)
    assert ask("u1") == '{"verdict": "NO"}'
    with pytest.raises(v.NoReply, match="open"):
        ask("u2")
    with pytest.raises(v.NoReply, match="exhausted"):
        ask("u3")
    assert client.open == [("t", hash16("u2"))]
    with pytest.raises(RuntimeError, match="unexpected judge call"):
        ask("u1", max_tokens=512)


def test_the_table_gives_mem0s_published_row_from_its_counts():
    def rows(variant: str, right: int, n: int) -> list[dict]:
        return [{"variant": variant, "category": "state_tracking", "judge_correct": i < right, "verdict": "YES",
                 "rule_based_slot_match": 1.0} for i in range(n)]
    lines = th.table(rows("positive_clean", 348, 488) + rows("positive_overloaded", 164, 488)
                     + rows("negative_clean", 161, 289))
    got = " ".join(lines)
    assert all(x in got for x in ("71.31 (348/488)", "33.61 (164/488)", "55.71 (161/289)", "52.46 (512/976)",
                                  "53.20 (673/1265)"))
