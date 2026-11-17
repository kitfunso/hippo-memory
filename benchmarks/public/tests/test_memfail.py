"""memfail/: MemFail's pinned code, its gpt-5-mini settings on the wire, the ledger client the vendor judges call, and
the store the judges read (notes-2026-11-17-memfail.md)."""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

import pytest
from conftest import PUBLIC, write_log

sys.path.insert(0, str(PUBLIC / "memfail"))
from qa import openai_llm as ol  # noqa: E402  (the module vendor.py builds its Settings from)
import vendor as v  # noqa: E402
from qa.ledger import hash16  # noqa: E402
from qa.vendor_pin import drift  # noqa: E402

needs_clone = pytest.mark.skipif(not (v.CLONE / ".git").exists(), reason="MemFail's clone is not on this box")
SCHEMA = {"type": "json_schema", "json_schema": {"name": "storage_check", "strict": True, "schema": {
    "type": "object", "properties": {"fact_in_store": {"type": "boolean"}}, "required": ["fact_in_store"],
    "additionalProperties": False}}}


def sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def test_the_published_setup_is_pinned():
    assert (v.COMMIT, v.MODEL, v.SNAPSHOT, v.SEED, v.TOPK) == (
        "61ab3028a6dc4a67b222f0d3a37a62e1d479ade9", "gpt-5-mini", "gpt-5-mini-2025-08-07", 42, 5)
    assert list(v.TASKS) == ["coexisting", "conditional", "conditional-hard", "persona", "long-hop"]
    assert [t for t, x in v.TASKS.items() if x.hard] == ["conditional-hard"]
    assert v.GPT5_MINI == ol.Settings("gpt-5-mini-2025-08-07", temperature=None) and v.EFFORT == "default"


@needs_clone
def test_the_clone_is_the_pinned_code_and_the_template_is_its_text():
    assert drift(v.CLONE, v.COMMIT, v.BLOBS) == []
    assert sha(v.prompt("Q?", "", [], False)) == "71886cbf105da9410cbb10d47cce0bd545d60010e032d265f4dae91272b914b9"
    assert sha(v.prompt("Q?", "", [("a", "b")], False)) == \
        "8fff563c8499e78fbac75abd7c3645e38937a7d78c2a57ff734c3e91efd921fa"
    assert sha(v.prompt("Q?", "- user: a", [], True)) == \
        "d6eb4116c306ea7f69f44949b93a4bd59c760f2e88956567a425e14e6675c3b3"


@needs_clone
def test_each_task_builds_the_papers_question_counts():
    sizes = {t: (sum(map(len, s)), len(q)) for t in v.TASKS for s, _, q in [v.chat_dataset(t)]}
    assert sizes == {"coexisting": (340, 100), "conditional": (100, 100), "conditional-hard": (100, 100),
                     "persona": (100, 300), "long-hop": (274, 92)}


def test_answers_and_judges_send_what_memfail_sends(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    spend = tmp_path / "spend"
    answer = json.loads(ol.OpenAIChat(tmp_path / "a.jsonl", v.GPT5_MINI, spend=spend)._body("", "p"))
    assert answer == {"model": "gpt-5-mini-2025-08-07", "messages": [{"role": "user", "content": "p"}]}
    judge = ol.OpenAIChat(tmp_path / "j.jsonl", ol.Settings(v.SNAPSHOT, temperature=None,
                                                              response_format=json.dumps(SCHEMA)), spend=spend)
    assert json.loads(judge._body("s", "u")) == {"model": "gpt-5-mini-2025-08-07", "response_format": SCHEMA,
                                                 "messages": [{"role": "system", "content": "s"},
                                                              {"role": "user", "content": "u"}]}


def test_memories_are_mem0_wrapper_lines_and_the_store_is_one_memory_per_message():
    assert v.memories_text(["user: a", "assistant: b"]) == "- user: a\n- assistant: b"
    import memfail_hippo as mh
    turns = [{"role": "user", "content": " fact "}, {"role": "assistant", "content": ""},
             {"role": "assistant", "content": "ok"}]
    assert mh.all_memories(turns) == ["user: fact", "assistant: ok"]


def test_a_persona_batch_is_valid_only_with_a_verdict_for_every_id():
    user = "ALL_MEMORIES:\n- x\n\n[id=1]\nENTITY: a\n\n[id=2]\nENTITY: b"
    parse = v.reply_parse(user, batches=True)
    assert parse('{"results": [{"id": 1}]}') is None
    assert parse('{"results": [{"id": 2}, {"id": 1}]}') == {"results": [{"id": 2}, {"id": 1}]}
    assert v.reply_parse(user, batches=False)('{"fact_in_store": true}') == {"fact_in_store": True}
    assert v.reply_parse("u", batches=False)("not json") is None


def record(tag: str, system: str, user: str, text: str, event: str = "ok") -> dict:
    cli = ol.Settings(v.SNAPSHOT, temperature=None, response_format=json.dumps(SCHEMA)).cli
    return {"tag": tag, "sys": hash16(system), "user": hash16(user), "effort": v.EFFORT, "cli": cli, "event": event,
            "models": [v.SNAPSHOT], "text": text, "usage": {"prompt_tokens": 7, "completion_tokens": 3}, "ts": 0.0}


def ask(client: v.LedgerClient, user: str):
    return client.chat.completions.create(model="gpt-5-mini", response_format=SCHEMA,
                                          messages=[{"role": "system", "content": "s"}, {"role": "user", "content": user}])


def test_the_judge_client_reads_the_first_valid_reply_lists_open_calls_and_raises_on_none(tmp_path):
    write_log(tmp_path / "storage_check.jsonl", [
        record("t storage_check", "s", "u1", "nope"), record("t storage_check", "s", "u1", '{"fact_in_store": true}'),
        *(record("t storage_check", "s", "u3", "x") for _ in range(3))])
    client = v.LedgerClient(tmp_path, "t", live=False, slots=1)
    got = ask(client, "u1")
    assert json.loads(got.choices[0].message.content) == {"fact_in_store": True} and got.usage.prompt_tokens == 7
    with pytest.raises(v.NoReply, match="open"):
        ask(client, "u2")
    with pytest.raises(v.NoReply, match="exhausted"):
        ask(client, "u3")
    assert client.open == [("t storage_check", hash16("u2"))]
    with pytest.raises(RuntimeError, match="unexpected judge call"):
        client.chat.completions.create(model="gpt-4o", response_format=SCHEMA, messages=[])


def test_threads_asking_one_schema_share_one_ledger(tmp_path, monkeypatch):
    # the vendor judge sends a trace's storage checks from 5 threads; two ledgers on one log lost a line (17 Nov dry run)
    import threading
    import time
    from concurrent.futures import ThreadPoolExecutor

    class SlowLedger(v.Ledger):
        def __init__(self, *a, **k):
            time.sleep(0.05)
            super().__init__(*a, **k)
    monkeypatch.setattr(v, "Ledger", SlowLedger)
    client, start = v.LedgerClient(tmp_path, "t", live=False, slots=1), threading.Barrier(8)

    def get(_):
        start.wait()
        return client._client("storage_check", json.dumps(SCHEMA))[0]
    with ThreadPoolExecutor(8) as pool:
        assert len({id(x) for x in pool.map(get, range(8))}) == 1

def test_a_clone_off_its_pin_is_named(tmp_path):
    def git(*a: str) -> str:
        return subprocess.run(["git", "-C", str(tmp_path), *a], capture_output=True, text=True, check=True).stdout.strip()
    git("init", "-q")
    (tmp_path / "f.py").write_bytes(b"x = 1\n")
    git("add", "f.py")
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "c")
    head, blob = git("rev-parse", "HEAD"), git("rev-parse", "HEAD:f.py")
    assert drift(tmp_path, head, {"f.py": blob}) == []
    (tmp_path / "f.py").write_bytes(b"x = 1\r\n")
    assert drift(tmp_path, head, {"f.py": blob, "g.py": blob}) == [
        f"f.py is blob {git('hash-object', '--no-filters', 'f.py')}, not {blob}", "g.py is missing"]
    assert drift(tmp_path, "0" * 40, {}) == [f"HEAD is {head}, not {'0' * 40}"]
    assert drift(Path(tmp_path / "none"), head, {})[0].endswith("is no git clone: clone it and check out " + head)
