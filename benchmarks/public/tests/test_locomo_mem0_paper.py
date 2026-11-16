"""mem0/locomo_mem0_paper.py: the Mem0 paper's prompt verbatim, each speaker's own hits in rank order, LoCoMo times."""
from __future__ import annotations

import hashlib
import json

import pytest

import locomo_mem0_paper as lm
from qa.mem0_paper_prompts import ANSWER_PROMPT

SPEAKERS = ("Caroline", "Melanie")


def hit(i: int, who: str, role: str = "user") -> dict:
    return {"memory": f"{role}: {who}: fact {i}", "created_at": "2023-05-08T13:56:00.000Z", "score": 1 - i / 1000}


def test_the_answer_prompt_is_the_papers_text():
    """sha256 of ANSWER_PROMPT at mem0ai/mem0 aae5989e78 evaluation/prompts.py (blob 1d857b4f)."""
    assert hashlib.sha256(ANSWER_PROMPT.encode()).hexdigest() == \
        "f3c786104816bba61d03b7f41c2be45009e6c8c296a04d9712ab1a59e4ae2399"


def test_each_speaker_gets_only_its_own_first_30_hits_in_rank_order():
    hits = [hit(i, SPEAKERS[i % 3 == 0], "assistant" if i % 2 else "user") for i in range(120)]
    one, two = lm.by_speaker(hits, SPEAKERS)
    assert len(one) == len(two) == lm.TOP_K
    assert one[:3] == [f"1:56 pm on 8 May, 2023: Caroline: fact {i}" for i in (1, 2, 4)]
    assert two[:2] == ["1:56 pm on 8 May, 2023: Melanie: fact 0", "1:56 pm on 8 May, 2023: Melanie: fact 3"]


def test_a_hit_from_no_speaker_stops_the_run():
    with pytest.raises(ValueError, match="names no speaker"):
        lm.by_speaker([hit(0, "Gina")], SPEAKERS)


def test_the_prompt_fills_every_field_as_jinja_would():
    p = lm.answer_prompt("What did Caroline do?", [hit(0, "Caroline"), hit(1, "Melanie")], SPEAKERS)
    assert "{{" not in p and "Memories for user Caroline:" in p and "Question: What did Caroline do?" in p
    assert json.dumps(["1:56 pm on 8 May, 2023: Melanie: fact 1"], indent=4) in p


@pytest.mark.parametrize("iso, want", [("2023-05-08T13:56:00.000Z", "1:56 pm on 8 May, 2023"),
                                       ("2022-01-20T00:05:00Z", "12:05 am on 20 January, 2022"),
                                       ("2023-10-09T12:00:00.000Z", "12:00 pm on 9 October, 2023")])
def test_times_read_as_locomo_writes_them(iso, want):
    assert lm.locomo_time(iso) == want
