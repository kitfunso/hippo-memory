"""qa/openai_llm.py: the published settings go on the wire, the ledger takes the record, the spend and free-token caps
stop calls."""
from __future__ import annotations

import email.message
import http.client
import io
import json
import os
import subprocess
import sys
import time
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

import pytest

import openai_llm as ol
from qa.ledger import Item, Ledger, Manifest

MODEL = "gpt-4o-mini-2024-07-18"


class Reply(io.BytesIO):
    def __init__(self, body: dict) -> None:
        super().__init__(json.dumps(body).encode())
        self.headers = email.message.Message()

    def __enter__(self):
        return self

    def __exit__(self, *a) -> None:
        self.close()


def ok(text: str = '{"label": "CORRECT"}', pt: int = 1000, ct: int = 10) -> dict:
    return {"model": MODEL, "choices": [{"message": {"content": text}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": pt, "completion_tokens": ct}}


def http_error(code: int, body: str) -> urllib.error.HTTPError:
    return urllib.error.HTTPError(ol.URL, code, "x", email.message.Message(), io.BytesIO(body.encode()))


@pytest.fixture
def wire(monkeypatch):
    """The bodies posted, and a queue of replies or errors to give back in order."""
    sent, queue = [], []

    def urlopen(req, timeout):
        sent.append(json.loads(req.data))
        nxt = queue.pop(0)
        if isinstance(nxt, Exception):
            raise nxt
        return Reply(nxt)

    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    for pool in ("BIG", "SMALL"):
        monkeypatch.delenv(f"OPENAI_FREE_DAILY_{pool}", raising=False)
    monkeypatch.setattr(ol.urllib.request, "urlopen", urlopen)
    monkeypatch.setattr(ol.time, "sleep", lambda s: None)
    return sent, queue


def client(tmp_path, settings: ol.Settings, cap: float = 60.0) -> ol.OpenAIChat:
    return ol.OpenAIChat(tmp_path / "calls.jsonl", settings, slots=2, spend=tmp_path / "spend", cap=cap)


def test_published_settings_go_on_the_wire_and_the_ledger_takes_the_reply(tmp_path, wire):
    sent, queue = wire
    s = ol.Settings(MODEL, json_object=True)
    llm = client(tmp_path, s)
    queue.append(ok())
    item = Item("official hippo-emb 200 conv0_q1", "", "judge this", Manifest(MODEL, ol.EFFORT, s.cli),
                lambda t: "CORRECT" in t or None)
    choice = Ledger(llm.log_path).settle(item, llm)
    assert choice.status == "valid" and choice.asks == 1
    assert sent == [{"model": MODEL, "temperature": 0.0, "messages": [{"role": "user", "content": "judge this"}],
                     "response_format": {"type": "json_object"}}]
    spend = [json.loads(x) for x in llm.spend_path.read_text().splitlines()]
    assert spend[0]["usd"] == pytest.approx((1000 * 0.15 + 10 * 0.60) / 1e6)


def test_a_system_role_prompt_and_max_tokens_are_sent_as_set(tmp_path, wire):
    sent, queue = wire
    llm = client(tmp_path, ol.Settings("gpt-4o-2024-08-06", role="system", max_tokens=10))
    queue.append({**ok("yes"), "model": "gpt-4o-2024-08-06"})
    rec = llm.ask("", "the whole prompt", effort=ol.EFFORT, tag="t")
    assert sent[0]["messages"] == [{"role": "system", "content": "the whole prompt"}] and sent[0]["max_tokens"] == 10
    assert rec["models"] == ["gpt-4o-2024-08-06"] and rec["cli"] == llm.cli


def test_no_call_starts_once_the_logged_spend_reaches_the_cap(tmp_path, wire):
    sent, queue = wire
    (tmp_path / "spend").mkdir()
    (tmp_path / "spend" / "other.jsonl").write_text(json.dumps({"usd": 5.0}) + "\n")
    llm = client(tmp_path, ol.Settings(MODEL), cap=5.0)
    queue.append(ok())
    with pytest.raises(RuntimeError, match="openai spend cap"):
        llm.ask("", "p", effort=ol.EFFORT, tag="t")
    assert sent == []


def test_a_rate_limit_waits_and_is_no_ask_but_a_spent_quota_stops(tmp_path, wire):
    sent, queue = wire
    llm = client(tmp_path, ol.Settings(MODEL))
    tpm = ('{"error": {"message": "Rate limit reached on tokens per min (TPM). Please try again in 20ms. You can '
           'increase your rate limit by adding a payment method at https://platform.openai.com/account/billing.", '
           '"type": "tokens", "code": "rate_limit_exceeded"}}')
    queue += [http_error(429, tpm), ok()]
    item = Item("t", "", "p", Manifest(MODEL, ol.EFFORT, llm.cli), lambda t: t)
    assert Ledger(llm.log_path).settle(item, llm).asks == 1 and len(sent) == 2
    queue.append(http_error(429, '{"error": {"code": "insufficient_quota"}}'))
    with pytest.raises(RuntimeError, match="refused the key or the account"):
        llm.ask("", "q", effort=ol.EFFORT, tag="u")


def test_each_process_writes_its_own_file_and_sees_the_others_spend(tmp_path, wire, monkeypatch):
    sent, queue = wire
    monkeypatch.setattr(ol, "RESUM_S", -1)
    a, b = client(tmp_path, ol.Settings(MODEL), cap=0.0025), client(tmp_path, ol.Settings(MODEL), cap=0.0025)
    queue += [ok(pt=10_000), ok(pt=10_000)]
    a.ask("", "p", effort=ol.EFFORT, tag="t")
    assert a.spend_path != b.spend_path and b"\r" not in a.spend_path.read_bytes()
    b.ask("", "q", effort=ol.EFFORT, tag="u")
    with pytest.raises(RuntimeError, match="openai spend cap"):
        a.ask("", "r", effort=ol.EFFORT, tag="v")
    assert len(sent) == 2


def test_a_reply_cut_off_after_sending_is_retried_and_counted_at_its_worst_case(tmp_path, wire):
    sent, queue = wire
    llm = client(tmp_path, ol.Settings(MODEL, max_tokens=100))
    queue += [http.client.IncompleteRead(b"x"), ok()]
    llm.ask("", "p", effort=ol.EFFORT, tag="t")
    spend = [json.loads(x) for x in llm.spend_path.read_text().splitlines()]
    assert len(sent) == 2
    assert [(s["prompt_tokens"], s["completion_tokens"]) for s in spend] == [(ol.worst_case(sent[0])[0], 100), (1000, 10)]
    queue += [urllib.error.URLError("refused"), ok()]  # no connection, so nothing ran and nothing counts
    llm.ask("", "q", effort=ol.EFFORT, tag="u")
    assert len(llm.spend_path.read_text().splitlines()) == 3


def test_retry_after_reads_the_header_then_the_message():
    h = email.message.Message()
    h["retry-after-ms"] = "250"
    assert ol.retry_after(h, "") == 0.25
    assert ol.retry_after(email.message.Message(), "Please try again in 1.5s.") == 1.5
    assert ol.retry_after(email.message.Message(), "") == 5.0


PUBLIC = Path(__file__).resolve().parents[1]
# Another lane's process: it logs a call's tokens, or holds a call in flight until its stdin closes and then dies.
CHILD = f"""
import sys
from pathlib import Path
sys.path[:0] = [{str(PUBLIC)!r}, {str(PUBLIC / "qa")!r}, {str(PUBLIC / "mem0")!r}]
import openai_llm as ol
spend = Path(sys.argv[1])
llm = ol.OpenAIChat(spend.parent / "child-calls.jsonl", ol.Settings("{MODEL}"), slots=1, spend=spend)
if sys.argv[2] == "charge":
    llm._charge(llm.model, {{"prompt_tokens": 5000, "completion_tokens": 1000}})
else:
    print(llm.free.take("small", 3000, 10**9), flush=True)
    sys.stdin.read()
"""


def test_the_free_cap_counts_every_process_spend_and_calls_in_flight(tmp_path, wire, monkeypatch):
    sent, queue = wire
    monkeypatch.setenv("OPENAI_FREE_DAILY_SMALL", "10000")
    spend, script = tmp_path / "spend", tmp_path / "child.py"
    script.write_text(CHILD, encoding="utf-8")
    env = {**os.environ, "OPENAI_API_KEY": "test-key", "PYTHONUTF8": "1"}
    subprocess.run([sys.executable, "-I", str(script), str(spend), "charge"], env=env, check=True, timeout=60)
    holder = subprocess.Popen([sys.executable, "-I", str(script), str(spend), "hold"], env=env, text=True,
                              stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    try:
        assert holder.stdout.readline().strip() == "(True, 6000)"
        llm = client(tmp_path, ol.Settings(MODEL, max_tokens=1000))
        assert llm.free.take("small", 1001, 10_000) == (False, 9000)
    finally:
        holder.stdin.close()
        holder.wait(60)
    assert llm.free.take("small", 1001, 10_000) == (True, 6000)  # the dead holder's call no longer counts
    llm.free.give_back("small", 1001)
    queue.append(ok(pt=3000, ct=900))
    llm.ask("", "p", effort=ol.EFFORT, tag="t")
    assert len(sent) == 1 and not list(spend.glob("*.inflight"))
    assert llm.free.take("small", 101, 10_000) == (False, 9900)


def test_a_call_past_the_free_cap_waits_for_the_next_utc_day(tmp_path, wire, monkeypatch):
    sent, queue = wire
    monkeypatch.setenv("OPENAI_FREE_DAILY_SMALL", "10000")
    clock, slept = [datetime(2026, 11, 17, 23, 0, tzinfo=timezone.utc).timestamp()], []

    def sleep(s: float) -> None:
        assert len(slept) < 3, "the wait never ends"
        slept.append(s)
        clock[0] += s

    monkeypatch.setattr(ol, "utc_now", lambda: clock[0])
    monkeypatch.setattr(ol.time, "sleep", sleep)
    client(tmp_path, ol.Settings(MODEL))._charge(MODEL, {"prompt_tokens": 9000, "completion_tokens": 500})
    llm = client(tmp_path, ol.Settings(MODEL, max_tokens=500))
    queue.append(ok(pt=30, ct=5))
    assert llm.ask("", "p", effort=ol.EFFORT, tag="t")["event"] == "ok"
    assert slept == [3630.0] and len(sent) == 1
    waits = [r for r in map(json.loads, llm.log_path.read_text().splitlines()) if r.get("event") == "free-cap-wait"]
    assert [(w["pool"], w["used"], w["until"]) for w in waits] == [("small", 9500, "2026-11-18T00:00:30Z")]
    rec = json.loads(llm.spend_path.read_text().splitlines()[0])
    assert time.gmtime(rec["ts"])[:3] == (2026, 11, 18) and rec["pool"] == "small"
    assert client(tmp_path, ol.Settings(MODEL)).free.take("small", 0, 10_000) == (True, 35)  # a new reader's today


def test_every_spend_folder_counts_and_a_record_without_a_pool_goes_by_its_model(tmp_path, wire, monkeypatch):
    monkeypatch.setenv("OPENAI_FREE_DAILY_BIG", "10000")
    gpt4o = "gpt-4o-2024-08-06"
    other = ol.OpenAIChat(tmp_path / "a.jsonl", ol.Settings(gpt4o), spend=tmp_path / "openai-spend-gpt5.d", cap=60.0)
    other._charge("gpt-5-2025-08-07", {"prompt_tokens": 6000, "completion_tokens": 900})
    legacy = {"ts": time.time(), "model": gpt4o, "prompt_tokens": 3000, "completion_tokens": 0, "usd": 0.0}
    (tmp_path / "openai-spend.d").mkdir()
    (tmp_path / "openai-spend.d" / "legacy.jsonl").write_text(json.dumps(legacy) + "\n")
    llm = ol.OpenAIChat(tmp_path / "b.jsonl", ol.Settings(gpt4o, max_tokens=10), spend=tmp_path / "openai-spend.d",
                        cap=60.0)
    assert llm.free.take("big", 101, 10_000) == (False, 9900)
    assert llm.free.take("small", 101, 10_000) == (True, 0)


def test_a_model_in_no_free_pool_refuses_to_run(tmp_path, wire, monkeypatch):
    monkeypatch.setitem(ol.PRICES, "gpt-4o-2099-01-01", (1.0, 1.0))
    with pytest.raises(SystemExit, match="neither free-token pool"):
        client(tmp_path, ol.Settings("gpt-4o-2099-01-01"))


def test_a_call_bigger_than_the_whole_free_day_stops_and_sends_nothing(tmp_path, wire, monkeypatch):
    sent, _ = wire
    monkeypatch.setenv("OPENAI_FREE_DAILY_SMALL", "1000")
    monkeypatch.setattr(ol.time, "sleep", lambda s: pytest.fail("it waited for a day that can never hold it"))
    llm = client(tmp_path, ol.Settings(MODEL, max_tokens=2000))
    with pytest.raises(RuntimeError, match="owner's yes"):
        llm.ask("", "p", effort=ol.EFFORT, tag="t")
    assert sent == [] and not list((tmp_path / "spend").glob("*.inflight"))


def test_no_token_limit_counts_the_model_maximum_and_no_temperature_sends_none(tmp_path, wire):
    llm = client(tmp_path, ol.Settings(MODEL, temperature=None))
    body = json.loads(llm._body("s", "q"))
    assert "temperature" not in body and "temperature=unset" in llm.cli
    assert ol.worst_case(body)[1] == 16_384


def test_gpt5_mini_is_in_the_small_free_pool_at_its_list_price(tmp_path, wire):
    # help.openai.com/en/articles/10306912 lists gpt-5-mini-2025-08-07 in the 2.5M Build group (read 17 Nov 2026)
    llm = client(tmp_path, ol.Settings("gpt-5-mini-2025-08-07", temperature=None))
    assert llm.pool == "small" and ol.PRICES["gpt-5-mini-2025-08-07"] == (0.25, 2.00)
    assert ol.worst_case(json.loads(llm._body("", "q")))[1] == 128_000
