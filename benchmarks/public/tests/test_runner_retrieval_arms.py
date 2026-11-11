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


@pytest.mark.parametrize("arm, health, ok", [
    ("hippo-emb", {"arm": "hippo", "embeddings": True}, True),
    ("hippo-emb", {"arm": "hippo", "embeddings": False}, False),
    ("hippo365", {"arm": "hippo", "embeddings": False}, True),
    ("hippo365", {"arm": "hippo", "embeddings": True}, False),
    ("bm25", {"arm": "hippo", "embeddings": False}, False),
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
