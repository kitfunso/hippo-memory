"""qa/loaders/imlogic.py and mem0/imlogic_openai.py: the authors' prompt, seed-42 option shuffle and exact option match,
and GPT-5.1 on the wire with their settings."""
from __future__ import annotations

import ast
import json
import random
import re
import sys

import pytest

import imlogic_openai as io_
from conftest import rec, write_log
from qa import harness
from qa.loaders import imlogic as im
from qa.openai_llm import EFFORT

USER = {"uuid": "u-0", "persona_info": " Name: Ann; Gender: Female ", "sessions": [
    {"dialogue": [{"role": "user", "content": "I run marathons.", "timestamp": "Sep 04, 2025, 18:42:18"},
                  {"role": "assistant", "content": "Great!", "timestamp": "Sep 04, 2025, 18:42:18"}]},
    {"dialogue": [{"role": "user", "content": "   ", "timestamp": "Sep 05, 2025, 09:00:00"}]}]}
KEYS = ("Correct", "Trap_Preference", "Trap_Fabrication", "Trap_Generic")
OPTIONS = {"Correct": "c text", "Trap_Preference": "p text", "Trap_Fabrication": "f text", "Trap_Generic": "g text"}
# What evaluate_common.py:318-325 gives: Random("42:user:question").shuffle over the option items in file order. The
# last two are the data's odd items: qa_user17 item 26 has three options, qa_user19 item 57 another key order.
AUTHORS_ORDER = [
    (0, 0, KEYS, ["Correct", "Trap_Generic", "Trap_Preference", "Trap_Fabrication"]),
    (0, 1, KEYS, ["Trap_Generic", "Trap_Preference", "Trap_Fabrication", "Correct"]),
    (7, 93, KEYS, ["Trap_Preference", "Trap_Fabrication", "Trap_Generic", "Correct"]),
    (19, 96, KEYS, ["Correct", "Trap_Generic", "Trap_Fabrication", "Trap_Preference"]),
    (17, 26, ("Correct", "Trap_Preference", "Trap_Generic"), ["Correct", "Trap_Preference", "Trap_Generic"]),
    (19, 57, ("Correct", "Trap_Preference", "Trap_Generic", "Trap_Fabrication"),
     ["Trap_Generic", "Trap_Fabrication", "Correct", "Trap_Preference"]),
]


def item(u: int = 0, j: int = 0, keys: tuple = KEYS, query: str = "Should I rest?", when: str | None = "Dec 31, 2032"):
    return {"qid": f"u{u:02d}-q{j:04d}", "user_id": "u-0", "user_index": u, "question_index": j, "question": query,
            "query_time": when, "options": {k: OPTIONS[k] for k in keys}, "gold": OPTIONS["Correct"], "ask_after": None}


@pytest.fixture
def one_user(monkeypatch):
    monkeypatch.setattr(im, "_users", lambda: (USER,))
    im.memory_count.cache_clear()
    yield
    im.memory_count.cache_clear()


def order(q: dict, seed: int = im.SHUFFLE_SEED) -> list[str]:
    return [o["option_key"] for o in im.lettered_options(q, seed)[1].values()]


def fixture_holds(order_of) -> bool:
    return all(order_of(item(u, j, keys)) == want for u, j, keys, want in AUTHORS_ORDER)


def test_seed_42_gives_the_authors_option_order_and_letters():
    assert fixture_holds(order)
    text, letters = im.lettered_options(item(0, 0))
    assert list(letters) == ["A", "B", "C", "D"] and text == "A. c text\nB. g text\nC. p text\nD. f text"


def test_mutation_the_shuffle_fixture_fails_on_a_wrong_seed_index_order_or_no_shuffle(monkeypatch):
    assert not fixture_holds(lambda q: order(q, seed=41))
    swapped = lambda q: {**q, "user_index": q["question_index"], "question_index": q["user_index"]}  # noqa: E731
    assert not fixture_holds(lambda q: order(swapped(q)))
    assert not fixture_holds(lambda q: list(q["options"]))
    real = random.Random
    monkeypatch.setattr(im.random, "Random", lambda seed: real(42))  # an integer seed in place of "42:user:question"
    assert not fixture_holds(order)


def test_the_template_and_system_message_are_the_authors_text_at_the_pinned_commit():
    src = im.ROOT / "eval" / "evaluate_common.py"
    if not src.exists():
        pytest.skip(f"{src} is not downloaded")
    names = {"MULTIPLE_CHOICE_PROMPT_TEMPLATE", "DEFAULT_SYSTEM_PROMPT", "OPTION_LETTERS"}
    tree = ast.parse(src.read_text(encoding="utf-8"))  # parsed as text, never run
    found = {t.id: ast.literal_eval(n.value) for n in tree.body
             if isinstance(n, ast.Assign) for t in n.targets if isinstance(t, ast.Name) and t.id in names}
    assert found == {"MULTIPLE_CHOICE_PROMPT_TEMPLATE": im.TEMPLATE, "DEFAULT_SYSTEM_PROMPT": im.SYSTEM,
                     "OPTION_LETTERS": im.OPTION_LETTERS}


def test_the_whole_prompt_is_the_authors_template_filled_in(one_user):
    system, user = im.answer_prompt(item(0, 0), [{"memory": " user: I run marathons. ",
                                                  "created_at": "2025-09-04T18:42:18.000Z"}])
    state = ("Execution_Rules:\n- Prefer retrieved memories over generic assumptions.\n"
             "- If memories conflict, prioritize the most recent evidence-supported memory.\n"
             "- Do not fabricate facts that are not grounded in retrieved context.\nPersonalized_Logical_Evidences:\n"
             "- User UUID: u-0\n- Session Count: 2\n- Available Memory Count: 2\n"
             "- Persona Summary: Name: Ann; Gender: Female")
    assert system == "Follow the prompt exactly and return only the requested output."
    assert user == im.TEMPLATE.format(global_state=state, context="1. [Sep 04, 2025, 18:42:18] (Unknown type) user: I "
                                      "run marathons.", query="[Dec 31, 2032] Should I rest?",
                                      options_str="A. c text\nB. g text\nC. p text\nD. f text")


def test_no_persona_leaves_its_line_out(one_user, monkeypatch):
    monkeypatch.setattr(im, "_users", lambda: ({**USER, "persona_info": "  "},))
    assert im.global_state(item()).splitlines()[-1] == "- Available Memory Count: 2"


def test_each_memory_is_the_authors_numbered_line_and_all_top_30_are_shown(one_user):
    mems = [{"id": f"m{i}", "memory": f"user: fact {i}", "score": 0.5, "created_at": "2025-09-04T18:42:18.000Z"}
            for i in range(30)]
    lines = [x for x in im.answer_prompt(item(), mems)[1].splitlines() if re.match(r"\d+\. \[", x)]
    assert im.TOPK == 30 and len(lines) == 30
    assert lines[0] == "1. [Sep 04, 2025, 18:42:18] (Unknown type) user: fact 0" and lines[-1].startswith("30. [")
    assert im.context([]) == "(No retrieved memories.)"
    assert im.context([{"memory": "x"}]) == "1. [Unknown time] (Unknown type) x"


def test_the_query_carries_its_time_as_the_authors_do():
    assert im.prompt_query(item()) == "[Dec 31, 2032] Should I rest?"
    assert im.prompt_query(item(query="On Dec 31, 2032 should I rest?")) == "On Dec 31, 2032 should I rest?"
    assert im.prompt_query(item(query=" ")) == "[Dec 31, 2032]"
    assert im.prompt_query(item(when=None)) == "Should I rest?"


def test_a_reply_scores_by_the_authors_letter_parse_and_exact_option_match():
    q = item(0, 0)  # A is Correct
    assert all(im.is_correct(q, r) for r in ("A", " a ", "Answer: A"))
    assert not any(im.is_correct(q, r) for r in ("B", "", "I choose A"))  # "I" is the first lone capital: no letter
    assert io_.accuracy({"a": True, "b": False, "c": False, "d": True}, list("abcd")) == 50.0


def test_gpt51_goes_with_the_authors_settings_only(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setenv("OPENAI_BILLED_MODELS", io_.GPT51.model)
    llm = io_.OpenAIChat(tmp_path / "calls.jsonl", io_.GPT51, slots=1, spend=tmp_path / "spend", cap=1.0)
    assert json.loads(llm._body(im.SYSTEM, "the prompt")) == {
        "model": "gpt-5.1-2025-11-13", "temperature": 0.0,
        "messages": [{"role": "system", "content": im.SYSTEM}, {"role": "user", "content": "the prompt"}]}


def make_run(tmp_path, qs: list[dict], mems: list[dict], stored: int = 2):
    """A harness run folder: user u-0's ingest record, one manifest-checked retrieval per question."""
    run = tmp_path / "run"
    (run / "ingest" / "hippo-emb").mkdir(parents=True)
    (run / "ingest" / "hippo-emb" / "done.jsonl").write_text(
        json.dumps({"user": "u-0", "phase": "ingest", "turns": 3, "stored": stored, "questions": 0}) + "\n"
        + json.dumps({"user": "u-0", "phase": "retrieve", "turns": 3, "stored": 99, "questions": len(qs)}) + "\n")
    for q in qs:
        harness.write_pred(run, "hippo-emb", q, mems, im.TOPK, 3)
    man = {q["qid"]: harness.sha_bytes(harness.pred_path(run, "hippo-emb", q["qid"]).read_bytes()) for q in qs}
    (run / "predicted" / "manifest.json").write_text(json.dumps({"hippo-emb": man}))
    (run / "questions.json").write_text(json.dumps({"qids": [q["qid"] for q in qs]}))
    return run


MEMS = [{"id": "m1", "memory": "user: I run marathons.", "score": 0.9, "created_at": "2025-09-04T18:42:18.000Z"}]


def test_score_keeps_a_reply_with_no_letter_and_an_exhausted_answer_in_n_as_wrong(tmp_path, one_user, monkeypatch):
    qs = [item(0, 0), item(0, 1), item(0, 2)]
    monkeypatch.setattr(im, "questions", lambda: qs)
    run, out = make_run(tmp_path, qs, MEMS), tmp_path / "out"
    out.mkdir()
    m = io_.GPT51.model
    usage = {"prompt_tokens": 1000, "completion_tokens": 1}

    def ask(q: dict, text: str, model: str = m) -> dict:
        return {**rec(f"imlogic gpt51 answer hippo-emb {q['qid']}", im.answer_prompt(q, MEMS)[1], system=im.SYSTEM,
                      text=text, model=model, effort=EFFORT, cli=io_.GPT51.cli), "usage": usage}
    write_log(out / "calls-answer.jsonl", [ask(qs[0], "A"), ask(qs[1], "I pick"),
                                           *[ask(qs[2], "A", model="gpt-4o-2024-08-06")] * 3])
    io_.stage_score(im, "hippo-emb", run, out, qs, smoke=True)
    text = (out / "score.txt").read_text(encoding="utf-8")
    assert "accuracy 33.33  n=3  all items" in text and "no valid option letter, scored wrong: 1" in text
    assert "answers exhausted after 3 asks, scored wrong: 1" in text
    assert "prompt 2000, completion 2 (reasoning 0) over 2 replies" in text and "top 30, gpt-5.1-2025-11-13" in text


def test_a_store_that_took_another_count_stops_before_any_prompt(tmp_path, one_user):
    run = make_run(tmp_path, [item()], MEMS, stored=5)
    with pytest.raises(SystemExit, match="5 memories stored"):
        io_.answer_items(im, "hippo-emb", run, [item()])


def test_the_harness_runs_an_extra_arm_unpaired_only_when_told(tmp_path, monkeypatch):
    class Reached(Exception):
        pass

    def setup(a):
        raise Reached
    monkeypatch.setattr(harness, "setup", setup)
    base = ["harness.py", "ingest", "--bench", "imlogic", "--out", str(tmp_path / "run"), "--arm", "hippo-emb"]
    for extra, want in (([], SystemExit), (["--alone", "--pairs-with", str(tmp_path / "reg")], SystemExit),
                        (["--alone"], Reached)):
        monkeypatch.setattr(sys, "argv", base + extra)
        with pytest.raises(want):
            harness.main()


def test_the_dry_run_writes_the_prompts_and_never_builds_a_client(tmp_path, one_user, monkeypatch):
    qs = [item(0, 0), item(0, 1), item(0, 2)]
    monkeypatch.setattr(im, "questions", lambda: qs)
    monkeypatch.setattr(io_, "OpenAIChat", lambda *a, **k: pytest.fail("the dry run built a client"))
    run, dest = make_run(tmp_path, qs, MEMS), tmp_path / "prompts.txt"
    monkeypatch.setattr(sys, "argv", ["imlogic_openai.py", "answer", "--arm", "hippo-emb", "--run", str(run),
                                      "--limit", "2", "--dry-run", str(dest)])
    io_.main()
    text = dest.read_text(encoding="utf-8")
    assert text.count("=== u00-q") == 2 and "gold A" in text and "gold D" in text  # (0, 1) puts Correct last
    assert not (run / "smoke").exists()
