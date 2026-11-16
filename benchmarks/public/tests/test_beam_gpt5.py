"""answer_judge --models gpt-5 and runner/beam_gpt5.py (prereg dated notes 29): the gpt-4o manifests stay as they were,
and the score is the runner's own mean over every item, an answer with no valid reply scored 0."""
from __future__ import annotations

import pytest
from conftest import RUNNER

pytest.importorskip("aiolimiter", reason="the runner modules import only with the runner venv's packages")
if not (RUNNER / "benchmarks" / "beam" / "run.py").exists():
    pytest.skip("answer_judge imports Mem0's runner checkout", allow_module_level=True)

import answer_judge as aj  # noqa: E402
import beam_gpt5 as b5  # noqa: E402


def test_gpt4o_records_still_meet_their_manifest_and_gpt5_judges_in_json():
    _, effort, roles, kind = aj.OPENAI_MODELS["gpt-4o"]
    assert (effort, kind) == ("none", "lme")
    assert {r: s.cli for r, s in roles.items()} == dict.fromkeys(
        ("answer", "judge"), "openai chat.completions role=user temperature=0.0 max_tokens=4096 json_object=False")
    _, effort, roles, kind = aj.OPENAI_MODELS["gpt-5"]
    assert (effort, kind, roles["answer"].json_object, roles["judge"].json_object) == ("default", "beam", False, True)


def cut(score: float, answer: str = "a") -> dict:
    return {"score": score, "generated_answer": answer}


def test_the_score_is_the_runners_mean_with_an_exhausted_answer_at_zero():
    results = {"a": {"question_type": "abstention", "cutoff_results": {"top_200": cut(1.0), "top_50": cut(0.0, "")}},
               "b": {"question_type": "abstention", "cutoff_results": {"top_200": cut(0.5), "top_50": cut(0.5)}},
               "c": {"question_type": "abstention", "exhausted": ["answer bm25 c"]}}
    lines, _ = b5.score_lines(results, ["a", "b", "c"], {"c"})
    assert lines == ["top_200  score  50.0  pass  66.7  n=3  all items", "top_50  score  16.7  pass  33.3  n=3  all items",
                     "top_200  score  75.0  pass 100.0  n=2  primary", "top_50  score  25.0  pass  50.0  n=2  primary",
                     "top_200  empty answers 0", "top_50  empty answers 1",
                     "answers with no valid reply in 3 asks (scored 0): 1"]
