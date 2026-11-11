"""runner/score.py pooled BEAM mode (prereg Amendment 6 dated notes 3, entry 1): one primary over the four sizes, each
size's smoke items left out, the conversation as the unit, every size loaded and checked as a single-size run loads it."""
from __future__ import annotations

import json
import random
import shutil
import sys
from types import SimpleNamespace

import pytest
from conftest import RUNNER

pytest.importorskip("aiolimiter", reason="the runner modules import only with the runner venv's packages")
if not (RUNNER / "benchmarks" / "beam" / "run.py").exists():
    pytest.skip("answer_judge imports Mem0's runner checkout", allow_module_level=True)

import answer_judge as aj  # noqa: E402
import score  # noqa: E402

X, Y = score.X, score.Y
SIZES = tuple(aj.BEAM_SIZES)
CONVS = {"beam-100k": 2, "beam-500k": 3, "beam-1m": 3, "beam-10m": 1}  # conversations per size
PER_CONV, TYPES = 4, ("abstention", "event_ordering")
SPENT = ("bm25", "500K_1_q2_abstention")  # the one answer with no valid reply in 3 asks


def ids_of(bench: str) -> list[str]:
    return [f"{aj.BEAM_SIZES[bench]}_{c}_q{i}_{TYPES[i % 2]}" for c in range(CONVS[bench]) for i in range(PER_CONV)]


def result(qid: str, value: float | None) -> dict:
    """A saved runner result; None is an answer with no valid reply in 3 asks, which has no cutoff_results."""
    if value is None:
        return {"question_type": "abstention", "exhausted": [f"answer bm25 {qid}: cli"]}
    top = {"score": value, "judgment": "PASS" if value >= 0.5 else "FAIL", "memories_evaluated": 100}
    return {"question_type": qid.rsplit("_", 1)[1], "cutoff_results": {"top_100": top}}


@pytest.fixture
def world(tmp_path, monkeypatch) -> SimpleNamespace:
    """Four sizes of answered BEAM results under root/beam-<size>/, the smoke table and the replay stubbed."""
    root, rng, truth = tmp_path / "results-r2", random.Random(7), {}
    smoke = {b: [ids_of(b)[0]] for b in SIZES}
    for bench in SIZES:
        recs = []
        for arm in (X, Y):
            pred = root / bench / "retrieval" / arm / f"predicted_{bench}"
            pred.mkdir(parents=True)
            for qid in ids_of(bench):
                (pred / f"{qid}.json").write_text(json.dumps({"question_id": qid}), encoding="utf-8")
                spent = (arm, qid) == SPENT
                truth[(arm, qid)] = 0.0 if spent else rng.choice((0.0, 0.5, 1.0))
                recs.append({"arm": arm, "qid": qid, "pred_sha256": "",
                             "result": result(qid, None if spent else truth[(arm, qid)])})
        (root / bench / "results.jsonl").write_text("".join(json.dumps(r) + "\n" for r in recs), encoding="utf-8")
    table = tmp_path / "smoke_excluded.json"
    table.write_text(json.dumps(smoke), encoding="utf-8")
    verified = []

    def verify(bench, arms, out, ids):  # the replay needs call logs; its own tests are in test_runner_backend.py
        verified.append((bench, out, len(ids)))
        return aj.results_on_file(out)

    monkeypatch.setattr("qa.ledger.SMOKE", table)
    monkeypatch.setattr(aj, "verify", verify)
    monkeypatch.setattr(score, "EXPECT", {**score.EXPECT, **{b: len(ids_of(b)) for b in SIZES}})
    return SimpleNamespace(root=root, truth=truth, smoke=smoke, verified=verified, tmp=tmp_path)


def primary_line(lines: list[str]) -> str:
    return next(x for x in lines if x.startswith("PRIMARY"))


def test_with_one_size_the_pooled_primary_equals_the_single_size_primary(world):
    bench = "beam-100k"
    arms = {arm: world.root / bench / "retrieval" / arm / f"predicted_{bench}" for arm in (X, Y)}
    alone_lines, alone = score.single(bench, arms, world.root / bench, 3)
    pooled_lines, pooled = score.pooled(world.root, (bench,), 3)
    assert primary_line(pooled_lines) == primary_line(alone_lines)
    assert [x for x in pooled_lines if "Bonferroni" in x] == [x for x in alone_lines if "Bonferroni" in x] != []
    assert pooled["pairs"]["score/all"] == alone["pairs"]["score/all"]
    assert (pooled["questions"], pooled["primary_questions"]) == (alone["questions"], alone["primary_questions"])


def test_smoke_items_of_every_size_are_left_out_of_the_primary(world):
    lines, out = score.pooled(world.root, SIZES, None)
    every = [q for b in SIZES for q in ids_of(b)]
    kept = [q for q in every if q not in {s for v in world.smoke.values() for s in v}]
    want = sum(world.truth[(X, q)] - world.truth[(Y, q)] for q in kept) / len(kept)  # equal weight per question
    assert (out["questions"], out["primary_questions"]) == (len(every), len(kept)) == (len(every), len(every) - 4)
    assert out["pairs"]["score/all"]["n"] == len(kept) and out["pairs"]["score/all"]["diff"] == pytest.approx(want)
    assert f"n={len(kept)} over" in primary_line(lines)
    assert f"n={len(every)} over" in next(x for x in lines if "all items with the smoke items" in x)
    assert next(x for x in lines if x.startswith("smoke items")).split(": ", 1)[1] == ", ".join(
        sorted(s for v in world.smoke.values() for s in v))
    for bench in SIZES:
        assert out["pairs"][f"score/{bench}"]["n"] == len(ids_of(bench)) - 1 and out["sizes"][bench] == {
            "questions": len(ids_of(bench)), "primary_questions": len(ids_of(bench)) - 1}


def test_the_unit_count_is_the_conversations_across_sizes(world):
    lines, out = score.pooled(world.root, SIZES, None)
    assert out["pairs"]["score/all"]["units"] == sum(CONVS.values()) == 9
    assert f"over {sum(CONVS.values())} units" in primary_line(lines)
    assert {b: out["pairs"][f"score/{b}"]["units"] for b in SIZES} == CONVS


def test_the_interval_does_not_depend_on_the_order_the_sizes_are_listed_in(world):
    _, forward = score.pooled(world.root, SIZES, None)
    _, backward = score.pooled(world.root, SIZES[::-1], None)
    assert forward["pairs"]["score/all"] == backward["pairs"]["score/all"]


def test_every_size_is_verified_against_its_own_call_logs_and_exhausted_items_are_listed_per_size(world):
    lines, out = score.pooled(world.root, SIZES, None)
    total = sum(len(ids_of(b)) for b in SIZES)
    assert lines[0] == (f"beam pooled over 4 sizes: {total} questions, {total - 4} in the primary, results {2 * total}, "
                        f"all match the call logs")
    assert world.verified == [(b, world.root / b, len(ids_of(b))) for b in SIZES]
    assert "beam-500k: questions with a prompt exhausted after 3 asks (that step scored wrong): 1" in lines
    assert "beam-100k: questions with a prompt exhausted after 3 asks (that step scored wrong): 0" in lines
    assert f"  {SPENT[0]} {SPENT[1]}: answer bm25 {SPENT[1]}: cli" in lines
    assert world.truth[SPENT] == 0.0 and out["bench"] == "beam"


def test_a_size_short_of_its_questions_stops_the_run_as_in_a_single_size_run(world):
    next((world.root / "beam-500k" / "retrieval" / X / "predicted_beam-500k").glob("*.json")).unlink()
    with pytest.raises(SystemExit, match="never scored partial"):
        score.pooled(world.root, SIZES, None)


def run_cli(monkeypatch, *argv: str) -> None:
    monkeypatch.setattr(sys, "argv", ["score.py", *argv])
    score.main()


def test_a_missing_size_directory_exits_with_a_clear_message_before_any_scoring(world, monkeypatch):
    shutil.rmtree(world.root / "beam-1m")
    out = world.tmp / "pooled"
    with pytest.raises(SystemExit) as e:
        run_cli(monkeypatch, "--bench", "beam", "--root", str(world.root), "--out", str(out))
    assert "beam-1m" in str(e.value) and "scored pooled only when every size is answered" in str(e.value)
    assert world.verified == [] and not out.exists()  # no replay ran and nothing was written


def test_the_cli_writes_the_pooled_score_files_and_keeps_the_two_modes_apart(world, monkeypatch, capsys):
    out = world.tmp / "pooled"
    run_cli(monkeypatch, "--bench", "beam", "--root", str(world.root), "--out", str(out), "--bonferroni", "2")
    assert json.loads((out / "score.json").read_text(encoding="utf-8"))["primary_questions"] == sum(
        len(ids_of(b)) for b in SIZES) - 4
    assert (out / "score.txt").read_text(encoding="utf-8").strip() == capsys.readouterr().out.strip()
    for argv in (["--bench", "beam", "--out", str(out)], ["--bench", "beam-100k", "--root", str(world.root), "--out", str(out)],
                 ["--bench", "beam", "--root", str(world.root), "--pred", f"{X}=a", "--out", str(out)]):
        with pytest.raises(SystemExit) as e:
            run_cli(monkeypatch, *argv)
        assert e.value.code == 2
