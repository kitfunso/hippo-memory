"""memoryagentbench/mab_hippo.py: the authors' code copied whole, their configs, their requests and Table 3's sums."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "memoryagentbench"))
import mab_hippo as mab  # noqa: E402
import official  # noqa: E402
import vendor_copy  # noqa: E402
from qa.harness import sha_bytes  # noqa: E402
from qa.ledger import Choice  # noqa: E402
from qa.openai_llm import Settings  # noqa: E402

CLONE = vendor_copy.CLONE
HAVE_CLONE = (CLONE / ".git").exists()
DATA_CONF = {"sh_qa": "Accurate_Retrieval/Ruler/QA/Ruler_qa1_197k.yaml",
             "mh_qa": "Accurate_Retrieval/Ruler/QA/Ruler_qa2_421k.yaml",
             "lme": "Accurate_Retrieval/LongMemEval/Longmemeval_s_star.yaml",
             "eventqa": "Accurate_Retrieval/EventQA/Eventqa_full.yaml",
             "icl_banking77": "Test_Time_Learning/ICL/ICL_banking77.yaml",
             "icl_clinic150": "Test_Time_Learning/ICL/ICL_clinic150.yaml",
             "icl_nlu": "Test_Time_Learning/ICL/ICL_nlu.yaml",
             "icl_trec_coarse": "Test_Time_Learning/ICL/ICL_trec_coarse.yaml",
             "icl_trec_fine": "Test_Time_Learning/ICL/ICL_trec_fine.yaml",
             "recsys": "Test_Time_Learning/Recsys/Recsys_redial_full.yaml",
             "infbench_sum": "Long_Range_Understanding/InfBench_sum.yaml",
             "detective_qa": "Long_Range_Understanding/Detective_QA.yaml",
             "fc_sh": "Conflict_Resolution/Factconsolidation_sh_262k.yaml",
             "fc_mh": "Conflict_Resolution/Factconsolidation_mh_262k.yaml"}
# Table 3 (arXiv 2507.05257 v4), the 10 columns the averages take, and each row's Overall as printed
TABLE3 = {"Mem0": ({"SH-QA": 25.0, "MH-QA": 32.0, "LME(S*)": 36.0, "EventQA": 37.5, "MCC": 32.4, "Recom": 10.0,
                    "Summ": 4.8, "DetQA": 36.6, "FC-SH": 18.0, "FC-MH": 2.0}, 21.1),
          "HippoRAG-v2": ({"SH-QA": 76.0, "MH-QA": 66.0, "LME(S*)": 50.7, "EventQA": 67.6, "MCC": 61.4, "Recom": 10.2,
                           "Summ": 14.6, "DetQA": 57.7, "FC-SH": 54.0, "FC-MH": 5.0}, 41.6),
          "MemGPT": ({"SH-QA": 41.0, "MH-QA": 38.0, "LME(S*)": 32.0, "EventQA": 26.2, "MCC": 67.6, "Recom": 14.0,
                      "Summ": 2.5, "DetQA": 42.3, "FC-SH": 28.0, "FC-MH": 3.0}, 28.3)}


def test_official_is_the_pinned_copy():
    """Any edit to a copied prompt, template, metric or chunker changes this hash; vendor_copy.py rewrites it."""
    assert sha_bytes((Path(mab.__file__).parent / "official.py").read_bytes()) == \
        "4f89d67fe41e6c90302211bba1df26f6d80b4563254d732abc943bb7cc616543"


@pytest.mark.skipif(not HAVE_CLONE, reason="no clone of HUST-AI-HYZ/MemoryAgentBench in ~/hippo-bench/vendor")
def test_official_equals_a_fresh_cut_of_the_pinned_clone():
    assert vendor_copy.build(CLONE) == (Path(mab.__file__).parent / "official.py").read_text(encoding="utf-8")
    assert vendor_copy.PIN == mab.PIN


@pytest.mark.skipif(not HAVE_CLONE, reason="no clone of HUST-AI-HYZ/MemoryAgentBench in ~/hippo-bench/vendor")
@pytest.mark.parametrize("key", list(DATA_CONF))
def test_each_task_is_its_shipped_data_config(key):
    import yaml
    cfg = yaml.safe_load((CLONE / "configs" / "data_conf" / DATA_CONF[key]).read_text(encoding="utf-8"))
    t = mab.TASK[key]
    assert (cfg["dataset"], str(cfg["sub_dataset"]).strip(), cfg["max_test_samples"], cfg["generation_max_length"],
            cfg["chunk_size"]) == (t.split, t.source, t.samples, t.gen, 4096)


@pytest.mark.skipif(not HAVE_CLONE, reason="no clone of HUST-AI-HYZ/MemoryAgentBench in ~/hippo-bench/vendor")
def test_the_reader_settings_are_the_bm25_agent_config():
    import yaml
    cfg = yaml.safe_load((CLONE / "configs/agent_conf/RAG_Agents/gpt-4o-mini/Simple_rag_gpt-4o-mini-bm25.yaml")
                         .read_text(encoding="utf-8"))
    assert (cfg["temperature"], cfg["retrieve_num"]) == (0.7, mab.TOPK)
    assert cfg["model"].startswith("gpt-4o-mini") and mab.MINI.startswith(cfg["model"])


def test_the_table_and_its_two_chunk_regimes():
    assert len(mab.TASKS) == 14 and sum(t.column == "MCC" for t in mab.TASKS) == 5
    assert {t.key for t in mab.TASKS if mab.chunk_size(t, "rag") == 512} == {"sh_qa", "mh_qa", "lme", "fc_sh", "fc_mh"}
    assert {mab.chunk_size(t, "memory") for t in mab.TASKS} == {4096}
    assert {c for cs in mab.COMPETENCY.values() for c in cs} == {t.column for t in mab.TASKS}


def test_the_rag_agent_templates_are_used():
    assert mab.AGENT and official.normalize_agent_name(mab.AGENT) == "rag_agent"
    assert official.get_template("ruler_qa1_197K", "system", mab.AGENT) == official.SYSTEM_MESSAGE == \
        "You are a helpful assistant that can read the context and memorize it for future retrieval."


def test_the_answer_request_is_the_bm25_readers(tmp_path, monkeypatch):
    """agent.py:886-903: memories with a trailing newline under "Memory i:", then the query; system template first."""
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    assert mab.reader_user(["a", "b"], "Q") == "Memory 1:\na\n\nMemory 2:\nb\n\nQ"
    assert mab.reader_user([], "Q") == "\nQ"
    t = mab.TASK["sh_qa"]
    llm = mab.OpenAIChat(tmp_path / "a.jsonl", mab.answerer(t), spend=tmp_path / "spend", cap=1.0)
    assert json.loads(llm._body("S", "U")) == {"model": "gpt-4o-mini-2024-07-18", "temperature": 0.7, "max_tokens": 50,
                                               "messages": [{"role": "system", "content": "S"},
                                                            {"role": "user", "content": "U"}]}
    assert {t.key: mab.answerer(t).max_tokens for t in mab.TASKS}["detective_qa"] == 2000


def test_the_judge_requests_are_the_authors(tmp_path, monkeypatch):
    """longmem_qa_evaluate.py:157-165 and summarization_evaluate.py:493 with OpenAIModel's top_p 0.9 and seed 42."""
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    lme = mab.OpenAIChat(tmp_path / "l.jsonl", mab.LME_JUDGE, spend=tmp_path / "spend", cap=1.0)
    assert json.loads(lme._body("", "P")) == {"model": "gpt-4o-2024-08-06", "temperature": 0.0, "max_tokens": 10,
                                              "messages": [{"role": "user", "content": "P"}]}
    summ = mab.OpenAIChat(tmp_path / "s.jsonl", mab.SUM_JUDGE, spend=tmp_path / "spend", cap=1.0)
    assert json.loads(summ._body("", "P")) == {"model": "gpt-4o-2024-08-06", "temperature": 0.1, "max_tokens": 4096,
                                               "top_p": 0.9, "seed": 42, "messages": [{"role": "user", "content": "P"}]}
    assert mab.SUM_JUDGE.cli.endswith("json_object=False top_p=0.9 seed=42")
    assert Settings("gpt-4o-2024-08-06", max_tokens=10).cli == \
        "openai chat.completions role=user temperature=0.0 max_tokens=10 json_object=False"  # older stamps unchanged


def test_judge_prompts_fill_as_the_scripts_fill_them():
    lme = {"qid": "lme-c000-q003", "task": "lme", "raw_question": "Where?", "answer": "Paris",
           "question_type": "multi-session", "question_id": "x_abs"}
    [item] = mab.judge_items("hippo-emb", lme, "Paris it is").values()
    assert item.system == "" and item.user == official.get_anscheck_prompt("multi-session", "Where?", "Paris",
                                                                            "Paris it is", abstention=True)
    summ = {"qid": "infbench_sum-c000-q000", "task": "infbench_sum", "answer": ["expert"], "keypoints": ["k1", "k2"]}
    items = mab.judge_items("hippo-emb", summ, " text ")
    assert items["recall"].user == official.recall_prompt_book.format(keypoints="1. k1\n2. k2", summary="text")
    assert items["precision"].user == official.precision_prompt_book.format(expert_summary="expert", summary="text")
    assert items["fluency"].user == official.fluency_prompt_book.format(text="text")
    assert mab.judge_items("hippo-emb", {"qid": "x", "task": "sh_qa"}, "a") == {}


def test_retrieval_queries_are_the_handlers():
    assert official._extract_retrieval_query(None, "Do X. \n\n Now Answer the Question: Who? \nAnswer:") == "Who? \nAnswer:"
    assert official._extract_retrieval_query(None, "...\n\n Here is the conversation: hi \n\n The") == "hi \n\n The"
    assert official._extract_retrieval_query(None, "plain") == "plain"


def test_memories_strip_the_server_prefix_and_check_the_manifest(tmp_path):
    p = mab.pred_path(tmp_path, "hippo-emb", "sh_qa-c000-q000")
    p.parent.mkdir(parents=True)
    raw = json.dumps({"results": [{"memory": "user: Dialogue a"}, {"memory": "user: Dialogue b"}]}).encode()
    p.write_bytes(raw)
    (tmp_path / "predicted" / "manifest.json").write_text(json.dumps({"hippo-emb": {"sh_qa-c000-q000": sha_bytes(raw)}}))
    assert mab.memories(tmp_path, "hippo-emb", "sh_qa-c000-q000") == ["Dialogue a", "Dialogue b"]
    p.write_bytes(raw + b" ")
    with pytest.raises(SystemExit):
        mab.memories(tmp_path, "hippo-emb", "sh_qa-c000-q000")


@pytest.mark.parametrize("row", list(TABLE3))
def test_the_averages_reproduce_table_3(row):
    cols, overall = TABLE3[row]
    qs, scores, n = [], {}, 0
    for t in mab.TASKS:  # one question per task; the five ICL tasks share the MCC value
        qs.append({"qid": f"q{n}", "task": t.key})
        scores[f"q{n}"] = cols[t.column] / 100
        n += 1
    got = mab.table(qs, scores)
    assert abs(got["Overall"] - overall) <= 0.05 + 1e-9 and round(got["MCC"], 1) == cols["MCC"]  # MemGPT: 28.25 prints 28.3


def test_scores_follow_the_scripts_and_a_missing_answer_scores_zero(monkeypatch):
    ok = lambda v: Choice("valid", 1, v, {"usage": {}})  # noqa: E731
    qs = [{"qid": "a", "task": "lme"}, {"qid": "b", "task": "infbench_sum", "keypoints": ["k"]},
          {"qid": "c", "task": "sh_qa"}, {"qid": "d", "task": "lme"}]
    answers = {"a": ok("x"), "b": ok("y"), "c": Choice("exhausted", 3), "d": ok("z")}
    judges = {("a", "lme"): ok(" Yes."), ("b", "fluency"): ok('{"fluency": 1}'), ("b", "recall"): ok('{"recall": 1}'),
              ("b", "precision"): ok("no json"), ("d", "lme"): Choice("exhausted", 3)}
    got, left_out = mab.question_scores(qs, answers, judges)
    assert got == {"a": 1.0, "b": None, "c": 0.0, "d": None} and left_out == ["b", "d"]
    assert mab.summary_f1({"fluency": '{"fluency": 1}', "recall": '{"recall": 1}',
                           "precision": '{"precision": 1, "sentence_count": 2}'}, {"keypoints": ["k", "l"]}) == 0.5


def test_the_smoke_is_seeded_and_spans_every_competency():
    qs = [{"qid": f"{t.key}-c000-q{i:03d}", "task": t.key} for t in mab.TASKS for i in range(3)]
    pick = mab.smoke_pick(qs)
    assert pick == mab.smoke_pick(list(qs)) and len(set(pick)) == 5
    cols = {mab.TASK[q.split("-c")[0]].column for q in pick}
    assert {"LME(S*)", "Summ"} <= cols
    assert all(set(members) & cols for members in mab.COMPETENCY.values())
