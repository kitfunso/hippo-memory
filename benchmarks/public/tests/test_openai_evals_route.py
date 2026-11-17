"""qa/openai_evals_route.py: rows hold the bytes the runner sends, and output items come back as asks the ledger takes."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

import halumem_openai as ho
from qa import openai_evals_route as route
from qa.ledger import Choice, Item, Ledger, Manifest, hash16
from qa.openai_llm import EFFORT, Settings

LOG = ho.R2 / "halumem-gpt4o" / "long" / "hippo-emb" / "calls-answer.jsonl"
NEEDS = (Path.home() / "hippo-bench" / "datasets" / "halumem" / "HaluMem-Long.jsonl",
         ho.R2 / "halumem-long-emb" / "predicted" / "manifest.json", LOG)
MINI = Settings("gpt-4o-mini-2024-07-18", temperature=0.0, max_tokens=16384)


def five_logged() -> dict[str, str]:
    """The first 5 HaluMem-Long questions the runner answered on the wire: qid to the user hash it logged sending."""
    out: dict[str, str] = {}
    for line in LOG.read_bytes().split(b"\n"):
        if len(out) < 5 and line.strip() and (r := json.loads(line)).get("event") == "ok":
            out[r["tag"].rsplit(" ", 1)[1]] = r["user"]
    return out


@pytest.fixture(scope="module")
def long5():
    if missing := [p for p in NEEDS if not p.exists()]:
        pytest.skip(f"needs the local HaluMem-Long data and its gpt-4o run: {missing[0]}")
    logged, mod = five_logged(), ho.loader("long")
    assert mod.DATA.name == "HaluMem-Long.jsonl"
    return mod, [q for q in mod.questions() if q["qid"] in logged], logged


def runner(tmp_path, monkeypatch) -> ho.OpenAIChat:
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    return ho.OpenAIChat(tmp_path / "calls.jsonl", ho.GPT4O, slots=1, spend=tmp_path / "spend", cap=1.0)


def rows_by_tag(d: Path) -> dict[str, dict]:
    return {r["item"]["tag"]: r["item"] for r in route.read_jsonl(d / "rows.jsonl")}


def test_answer_rows_hold_the_bytes_the_runner_sent_for_5_halumem_long_questions(long5, tmp_path, monkeypatch):
    mod, qs, logged = long5
    items = ho.answer_items(mod, "long", "hippo-emb", qs)
    route.render(items, ho.GPT4O, tmp_path / "r", "t")
    rows, llm = rows_by_tag(tmp_path / "r"), runner(tmp_path, monkeypatch)
    assert len(rows) == len(items) == 5
    for qid, item in items.items():
        body, row = llm._body(item.system, item.user), rows[item.tag]
        assert json.dumps(row["messages"]).encode() in body  # the runner's request body holds these bytes verbatim
        assert row["messages"] == json.loads(body)["messages"]
        assert hash16(row["messages"][-1]["content"]) == row["user"] == logged[qid]  # the hash it logged on 16 Nov
    run = json.loads((tmp_path / "r" / "run.json").read_text(encoding="utf-8"))["data_source"]
    sent = json.loads(llm._body("", "x"))
    assert run["model"] == sent["model"] == "gpt-4o-2024-08-06"
    assert run["sampling_params"] == {"temperature": sent["temperature"], "max_completions_tokens": sent["max_tokens"]}
    assert run["input_messages"] == {"type": "item_reference", "item_reference": "item.messages"}


def test_judge_rows_hold_the_bytes_the_runner_sends(long5, tmp_path, monkeypatch):
    mod, qs, _ = long5
    answers = {q["qid"]: Choice("valid", 1, f"answer to {q['qid']}") for q in qs}
    items = ho.judge_items(mod, "long", "hippo-emb", qs, answers)
    route.render(items, ho.GPT4O, tmp_path / "j", "t")
    rows, llm = rows_by_tag(tmp_path / "j"), runner(tmp_path, monkeypatch)
    assert len(rows) == 5
    for item in items.values():
        assert json.dumps(rows[item.tag]["messages"]).encode() in llm._body(item.system, item.user)


def output_item(n: int, row: dict, **sample) -> dict:
    s = {"input": row["messages"], "model": MINI.model, "temperature": 0.0, "max_completion_tokens": None,  # as on 17 Nov
         "max_completions_tokens": 16384, "seed": None, "top_p": 1.0,
         "output": [{"role": "assistant", "content": "1996-08-02"}], "finish_reason": "stop",
         "error": None, "usage": {"prompt_tokens": 50, "completion_tokens": 6, "total_tokens": 56, "cached_tokens": 0}}
    return {"id": f"outputitem_{n}", "datasource_item": row, "sample": {**s, **sample}}


def test_output_items_come_back_as_asks_the_ledger_takes(tmp_path):
    man = Manifest(MINI.model, EFFORT, MINI.cli)
    items = {k: Item(f"halumem-long gpt4o answer hippo-emb {k}", "", f"prompt {k}", man) for k in ("q1", "q2", "q3")}
    d = tmp_path / "run"
    route.render(items, MINI, d, "t")
    rows = [r["item"] for r in route.read_jsonl(d / "rows.jsonl")]
    (d / "sent.json").write_text(json.dumps({"eval_id": "eval_1", "run_id": "evalrun_1"}), encoding="utf-8")
    outs = [output_item(1, rows[0]), output_item(2, rows[1], error={"code": "x", "message": "y"}, output=[]),
            output_item(3, rows[2], input=[{"role": "user", "content": "another prompt"}])]
    (d / "output-items.jsonl").write_text("".join(json.dumps(o) + "\n" for o in outs), encoding="utf-8")
    log = tmp_path / "calls" / "calls-answer.jsonl"
    log.parent.mkdir()
    assert route.ingest(d, log) == 1  # the third item went out with other text: refused, never written
    got = {k: Ledger(log).choose(it) for k, it in items.items()}
    assert (got["q1"].status, got["q1"].value) == ("valid", "1996-08-02")
    assert got["q2"].status == got["q3"].status == "open"  # an error is no ask; a refused item is not in the log
    assert route.ingest(d, log) == 1 and len(route.read_jsonl(log)) == 2  # nothing is written twice


def test_a_field_the_run_cannot_carry_stops_render():
    with pytest.raises(SystemExit, match="no sampling_params field"):
        route.run_config([{"model": "m", "messages": [], "stop": ["\n"]}])
    with pytest.raises(SystemExit, match="rows differ"):
        route.run_config([{"model": "a", "messages": []}, {"model": "b", "messages": []}])
