"""Read the complete frozen roster once. A partial run can never emit an effect."""
from collections import Counter, defaultdict
from pathlib import Path
from statistics import mean, stdev
import json
import math
import subprocess

from scipy.stats import t

ROOT = Path("C:/z0-lessons/lesson-knockout/unit")
PLAN = Path(__file__).with_name("plan.mjs")
ARMS = ("T", "Tp", "N")
DIGEST = "7b3e3078f73cd6c11a2a6e50aabad48728016f5aae6f28a2db50daa1db8a2e42"


def contrast(units: list[dict], exclude_na: bool) -> dict:
    groups = defaultdict(list)
    for u in units:
        a, b = u["N"], u["T"]
        if exclude_na and "na" in (a["verdict"], b["verdict"]):
            continue
        groups[a["repo"]].append(int(a["verdict"] != "pass") - int(b["verdict"] != "pass"))
    values = [mean(v) for v in groups.values()]
    df = len(values) - 1
    point = mean(values) if values else None
    margin = t.ppf(.975, df) * stdev(values) / math.sqrt(len(values)) if df > 0 else None
    return dict(pairs=sum(map(len, groups.values())), repos=len(values), df=df, estimate=point,
                low=point-margin if margin is not None else None,
                high=point+margin if margin is not None else None)


def report() -> dict:
    plan = json.loads(subprocess.check_output(["node", str(PLAN)], encoding="utf-8"))
    if plan["sha256"] != DIGEST:
        raise ValueError("Frozen task inputs changed")
    labels = json.loads(subprocess.check_output(["node", str(PLAN), "labels"], encoding="utf-8"))
    variants = set(labels["variant"])
    slots = {(u, a): i for u, _, _, order in plan["units"] for i, a in enumerate(order)}
    found = {}
    sessions = set()
    for f in ROOT.glob("*/evidence/apply-*/grade.json"):
        r = json.loads(f.read_text(encoding="utf-8"))
        key = r["id"], r["arm"]
        if (r["mode"] != "unit" or key not in slots or key in found
                or f.parents[2].name != r["id"] or f.parent.name != f"apply-{slots[key]}"
                or r["repo"] != r["id"].split("-")[0] or r["verdict"] not in {"pass", "fail", "na"}
                or r["session"] in sessions):
            raise ValueError(f"Invalid record {f}")
        if (r["id"] in variants and type(r["flagged"]) is not bool
                or r["id"] not in variants and r["flagged"] is not None):
            raise ValueError(f"Invalid variant eligibility {f}")
        sessions.add(r["session"])
        found[key] = r
    result = dict(planned=len(slots), observed=len(found), status="incomplete")
    if len(found) != len(slots):
        return result
    units = [{a: found[(u, a)] for a in ARMS} for u, *_ in plan["units"]]
    fork_errors = sum(len({(r["snapshotHash"], r["resetHash"], r["teachId"], r["targetCount"])
                           for r in u.values()}) != 1 for u in units)
    loss = sum(not r["hookSeen"] for r in found.values()) / len(found)
    noise = mean((u["T"]["verdict"] != "pass") != (u["Tp"]["verdict"] != "pass") for u in units)
    gates = dict(forkErrors=fork_errors, storeErrors=sum(not r["storeVerified"] for r in found.values()),
                 missingRequestEvidence=sum(not r["complete"] for r in found.values()),
                 neutralLeaks=sum(u["N"]["targetText"] for u in units), hookLoss=loss,
                 hookMissesByArm={a: sum(not u[a]["hookSeen"] for u in units) for a in ARMS}, disagreement=noise)
    violation = contrast(units, False)
    excluded = contrast(units, True)
    kills = []
    if violation["estimate"] < .15:
        kills.append("content")
    if noise > .15:
        kills.append("noise")
    bad = fork_errors or gates["storeErrors"] or gates["missingRequestEvidence"] or gates["neutralLeaks"] or loss >= .05
    passes = all(x["low"] is not None and x["low"] > 0 and x["estimate"] >= .15
                 for x in [violation, excluded])
    status = "invalid" if bad else "kill" if kills else "audit-required" if passes else "inconclusive"
    return dict(**{**result, "status": status}, gates=gates, kill=kills, violation=violation, excluded=excluded,
                emptyCaptures=sum(u["T"]["targetCount"] == 0 for u in units),
                flaggedFollows={a: dict(eligible=len(variants), flagged=sum(u[a]["flagged"] is True for u in units))
                                for a in ARMS},
                rawGrades={a: dict(Counter(u[a]["verdict"] for u in units)) for a in ARMS})


if __name__ == "__main__":
    print(json.dumps(report(), separators=(",", ":"), allow_nan=False))
