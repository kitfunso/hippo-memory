"""mem0/replay_locomo.py (prereg Amendment 6 dated notes 9): a replayed arm takes the Mem0 client's order, and no file
counts unless the hippo-emb replay gives back the saved results, the arm shows hippo-emb's memories at 200, and a
second search agrees."""
from __future__ import annotations

import pytest
from conftest import RUNNER

if not (RUNNER / "benchmarks" / "locomo" / "prompts.py").exists():
    pytest.skip("replay_locomo imports the harness, which needs Mem0's runner checkout", allow_module_level=True)

import replay_locomo as rl


def hit(i: int, score: float) -> dict:
    return {"id": f"m{i}", "memory": f"turn {i}", "score": score, "created_at": "2023-05-01T00:00:00.000Z"}


class Fake:
    """A server whose n-th search returns the n-th list it was given, then the last one."""

    def __init__(self, *lists: list[dict]) -> None:
        self.lists, self.n = lists, 0

    def call(self, method: str, path: str, body: dict) -> dict:
        res = self.lists[min(self.n, len(self.lists) - 1)]
        self.n += 1
        return {"results": [dict(r) for r in res]}


def saved_rec(results: list[dict]) -> dict:
    return {"question_id": "q", "user_id": "u", "retrieval": {"search_query": "q?", "search_results": results,
                                                               "search_latency_ms": 1.0, "total_results": len(results)}}


def test_the_client_order_is_highest_score_first_and_keeps_ties_in_server_order():
    got = rl.client_order([hit(1, 0.2), hit(2, 0.9), hit(3, 0.2)])
    assert [r["id"] for r in got] == ["m2", "m1", "m3"]
    assert set(got[0]) == {"id", "memory", "score", "created_at"}


def test_a_replay_keeps_the_arms_order_when_every_gate_passes():
    reg = rl.client_order([hit(1, 0.9), hit(2, 0.5), hit(3, 0.1)])
    arm = [hit(3, 1.0), hit(1, 0.66), hit(2, 0.33)]  # rank scores: the client sort keeps the arm's order
    files, problems, counts = rl.replay(["q"], {"q": saved_rec(reg)}, Fake(reg), Fake(arm))
    assert problems == [] and counts == {"gate1_same": 1, "gate2_same": 1, "gate3_same": 1}
    assert [r["id"] for r in files["q"]["retrieval"]["search_results"]] == ["m3", "m1", "m2"]


@pytest.mark.parametrize("base, arm, gate", [
    ([hit(1, 0.8), hit(2, 0.5), hit(3, 0.1)], None, "gate 1"),  # a moved score: not the store that run searched
    (None, [[hit(1, 1.0), hit(4, 0.5), hit(3, 0.2)]], "gate 2"),  # another memory at 200
    (None, [[hit(3, 1.0), hit(1, 0.6), hit(2, 0.3)], [hit(1, 1.0), hit(3, 0.6), hit(2, 0.3)]], "gate 3"),
])
def test_a_replay_names_the_gate_that_fails(base, arm, gate):
    reg = rl.client_order([hit(1, 0.9), hit(2, 0.5), hit(3, 0.1)])
    _, problems, _ = rl.replay(["q"], {"q": saved_rec(reg)}, Fake(base or reg), Fake(*(arm or [reg])))
    assert len(problems) == 1 and problems[0].startswith(gate)
