"""precisionmembench/: the pinned harness, the hippo registration and the provider's beliefId round trip
(notes-2026-11-17-precisionmembench.md)."""
from __future__ import annotations

import json
import sys

import pytest
from conftest import PUBLIC

sys.path.insert(0, str(PUBLIC / "precisionmembench"))
import pmb_hippo as pmb  # noqa: E402
from qa.vendor_pin import drift  # noqa: E402

needs_clone = pytest.mark.skipif(not (pmb.CLONE / ".git").exists(), reason="PrecisionMemBench's clone is not here")


def test_the_published_setup_is_pinned():
    assert pmb.COMMIT == "61a712a1754e7d27b6dee42da32a2c214b003ece" and pmb.ACTIVE_CASES == 43
    assert pmb.ENTRY == {"envVar": "HIPPO_URL", "defaultUrl": "http://localhost:8090", "seedDelayMs": 200,
                         "beliefToText": "canonical_name_aliases", "supportsUpdate": False}


@needs_clone
def test_the_clone_is_pinned_and_the_smoke_cases_are_its_cases():
    assert drift(pmb.CLONE, pmb.COMMIT, {**pmb.BLOBS, "providers.config.json": pmb.CONFIG_BLOB}) == []
    cases = [c["caseId"] for c in json.loads((pmb.CLONE / "fixtures" / "retrieval.cases.json").read_text("utf-8"))]
    assert len(cases) == 77 and tuple(cases[i] for i in (0, 19, 38, 57, 76)) == pmb.SMOKE


class FakeHippo:
    """hippo-mem0-server's two routes, enough for the provider."""

    def __init__(self) -> None:
        self.mem, self.deleted = [], []

    def call(self, method: str, path: str, body: dict) -> dict:
        if path == "/memories":
            self.mem.append((f"m{len(self.mem)}", body["user_id"], body["messages"][0]["content"]))
            return {"results": [{"id": self.mem[-1][0], "memory": "user: " + self.mem[-1][2], "event": "ADD"}]}
        hits = [m for m in reversed(self.mem) if m[1] == body["user_id"]][:body["limit"]]
        return {"results": [{"id": i, "memory": "user: " + t, "score": 0.5} for i, _, t in hits]}

    def delete(self, user: str) -> None:
        self.deleted.append(user)


def test_the_provider_returns_belief_ids_once_each_and_resets_every_user(tmp_path):
    p = pmb.Provider(FakeHippo(), tmp_path / "log.jsonl")
    for text, belief in (("a", "b-1"), ("b", "b-2"), ("a again", "b-1")):
        assert p.add({"text": text, "user_id": "u", "metadata": {"beliefId": belief}}) == {"ok": True}
    got = p.search({"query": "q", "user_id": "u", "limit": 20, "scope": ["domain:code"]})
    assert [r["id"] for r in got["results"]] == ["b-1", "b-2"]
    p.reset()
    assert p.srv.deleted == ["u"] and not p.belief_of
    assert [json.loads(x)["op"] for x in (tmp_path / "log.jsonl").read_text("utf-8").splitlines()] == \
        ["add", "add", "add", "search", "reset"]
