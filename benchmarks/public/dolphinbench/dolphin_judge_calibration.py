"""Judge agreement check: re-judge public DolphinBench judge conversations (Claude Code + Mem0
evidence, graded by Azure gpt-5.6-sol) through the codex-hosted judge and compare verdicts.
Usage (WSL): DOLPHIN_CODEX_HOME=<clean profile> python dolphin_judge_calibration.py [per_verdict_per_persona]"""
import gzip
import json
import sys
from concurrent.futures import ThreadPoolExecutor

from dolphin_smoke import BENCH, MODEL, codex_verdict

PER = int(sys.argv[1]) if len(sys.argv) > 1 else 5
WORK = BENCH / "runs" / "judge-calibration"


def verdicts(text: str) -> dict:
    parsed = json.loads(text)
    if "results" in parsed:
        return {row["check_id"]: row["passed"] for row in parsed["results"]}
    return {"field": parsed["passed"]}


def sample():
    """First PER Sol-pass and PER Sol-fail conversations per persona, in test order, deduplicated."""
    for persona in ("morgan", "alex", "riley"):
        doc = json.load(gzip.open(BENCH / "evidence" / f"{persona}-claude-mem0-results.json.gz"))
        seen, picked = set(), {True: 0, False: 0}
        for row in doc["test_results"]:
            for detail in row["grade"]["details"]:
                messages = detail.get("judge_messages") or []
                for start in range(0, len(messages), 3):
                    system, user, reply = (m["content"] for m in messages[start:start + 3])
                    sol = verdicts(reply)
                    passed = all(sol.values())
                    if user in seen or picked[passed] >= PER:
                        continue
                    seen.add(user)
                    picked[passed] += 1
                    yield f"{persona}-{row['test_id']}-{len(seen)}", system, user, sol


def judge(item):
    tag, system, user, sol = item
    try:
        return tag, sol, verdicts(codex_verdict(system, user, WORK, tag))
    except Exception as exc:  # a failed call is reported as a disagreement, never dropped
        return tag, sol, {"error": repr(exc)[:200]}


def main() -> None:
    WORK.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(3) as pool:
        results = list(pool.map(judge, list(sample())))
    for tag, sol, mine in results:
        if sol != mine:
            print("DISAGREE", tag, "sol", sol, "codex", mine)
    checks = [(v, mine.get(k)) for _, sol, mine in results for k, v in sol.items()]
    print(json.dumps({"model": MODEL, "conversations": len(results),
                      "conversation_agreement": sum(sol == mine for _, sol, mine in results),
                      "checks": len(checks), "check_agreement": sum(a == b for a, b in checks),
                      "sol_pass_checks": sum(a for a, _ in checks)}))


if __name__ == "__main__":
    main()
