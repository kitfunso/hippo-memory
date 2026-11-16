"""qa/openai_llm.py: the published settings go on the wire, the ledger takes the record, the spend cap stops calls."""
from __future__ import annotations

import email.message
import io
import json
import urllib.error

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
    queue += [http_error(429, '{"error": {"message": "Rate limit reached. Please try again in 20ms."}}'), ok()]
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


def test_retry_after_reads_the_header_then_the_message():
    h = email.message.Message()
    h["retry-after-ms"] = "250"
    assert ol.retry_after(h, "") == 0.25
    assert ol.retry_after(email.message.Message(), "Please try again in 1.5s.") == 1.5
    assert ol.retry_after(email.message.Message(), "") == 5.0
