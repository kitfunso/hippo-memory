"""mem0/personamem_memos.py: MemOS's prompt verbatim, every memory in rank order, the score as a mean over runs."""
from __future__ import annotations

import hashlib

import pytest

import personamem_memos as pmm
from qa.memos_pm_prompts import MEMOS_CONTEXT_TEMPLATE, PM_ANSWER_PROMPT

Q = {"qid": "q1", "question": "Which book next?", "options_raw": "['(a) x', '(b) y', '(c) z', '(d) w']", "gold": "(b)"}


def test_the_prompt_and_template_are_memos_text():
    """sha256 of each at MemTensor/MemOS 3a16e5fe evaluation/scripts/utils/prompts.py (vendor_memos_pm.py, 16 Nov)."""
    assert hashlib.sha256(PM_ANSWER_PROMPT.encode()).hexdigest() == \
        "401a24dc236f1354f9f8e645abebc85da75fe6acbbef2bfdbe7510d97ea06071"
    assert hashlib.sha256(MEMOS_CONTEXT_TEMPLATE.encode()).hexdigest() == \
        "5b9eff69503ea0e1abc7e5aeb8a48cb35b40c59f8a90166e420835687b3f6d89"


def test_the_context_holds_every_memory_in_rank_order_under_the_row_user():
    mems = [f"user: fact {i}" for i in range(20)]
    p = pmm.prompt(7, Q, mems)
    assert "Memories for user pm_exper_user_7_default:" in p and "\n".join(mems) in p
    assert "{" not in p.replace(Q["options_raw"], "") and Q["options_raw"] in p and "# QUESTION:\n    Which book next?" in p


@pytest.mark.parametrize("runs,want", [((True, True, False), 66.67), ((False, False, False), 0.0)])
def test_the_score_is_the_mean_over_runs_of_each_runs_accuracy(runs, want):
    right = {("q1", r): ok for r, ok in enumerate(runs, 1)} | {("q2", r): True for r in (1, 2, 3)}
    mean, sd = pmm.accuracy(right, ["q1", "q2"])
    assert mean == pytest.approx((want + 100) / 2, abs=0.01)
    assert sd == pytest.approx(0.0 if len(set(runs)) == 1 else 23.57, abs=0.01)
