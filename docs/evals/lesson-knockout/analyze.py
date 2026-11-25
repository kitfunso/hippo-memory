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
APPARATUS = 3


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


def is_hex(value: object, size: int) -> bool:
    return isinstance(value, str) and len(value) == size and all(c in "0123456789abcdef" for c in value)


def neutral_leak(r: dict) -> bool:
    return r["targetText"] or r["archivedTargetText"] or r["archivedUnauditable"] > 0


def read_roster() -> tuple[dict, dict]:
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
        if r.get("apparatus") != APPARATUS:
            raise ValueError(f"Receipt from before the apparatus fix {f}")
        key = r["id"], r["arm"]
        if (r["mode"] != "unit" or key not in slots or key in found
                or f.parents[2].name != r["id"] or f.parent.name != f"apply-{slots[key]}"
                or r["repo"] != r["id"].split("-")[0] or r["verdict"] not in {"pass", "fail", "na"}
                or r["session"] in sessions):
            raise ValueError(f"Invalid record {f}")
        if (r["id"] in variants and type(r["flagged"]) is not bool
                or r["id"] not in variants and r["flagged"] is not None):
            raise ValueError(f"Invalid variant eligibility {f}")
        audit = r.get("pathAudit") or {}
        if (type(audit.get("transcripts")) is not int or audit["transcripts"] < 1
                or not isinstance(audit.get("hits"), list)):
            raise ValueError(f"Missing transcript path audit {f}")
        if not (is_hex(r.get("preTree"), 40) and is_hex(r.get("ignoredSetup"), 64)
                and all(type(r.get(k)) is bool for k in ("targetText", "archivedTargetText", "hookSeen", "complete"))
                and all(type(r.get(k)) is int and r[k] >= 0
                        for k in ("sideRequests", "archivedAttempts", "archivedRefused", "archivedUnauditable"))
                and r.get("archivedPermissions") is True):
            raise ValueError(f"Missing tree or request audit fields {f}")
        sessions.add(r["session"])
        found[key] = r
    return slots, found


def disagreement(rows: list[dict]) -> float:
    return mean((u["T"]["verdict"] != "pass") != (u["Tp"]["verdict"] != "pass") for u in rows)


def flagged_counts(units: list[dict], include_contaminated: bool) -> dict:
    counts = {}
    for arm in ARMS:
        flags = [u[arm]["flagged"] for u in units if include_contaminated or not u[arm]["pathAudit"]["hits"]]
        counts[arm] = dict(eligible=sum(flag is not None for flag in flags), flagged=flags.count(True))
    return counts


def report() -> dict:
    slots, found = read_roster()
    result = dict(planned=len(slots), observed=len(found), status="incomplete")
    if len(found) != len(slots):
        return result
    units = [{a: found[(u, a)] for a in ARMS} for u, arm in slots if arm == "T"]
    fork_errors = sum(len({(r["snapshotHash"], r["resetHash"], r["teachId"], r["targetCount"])
                           for r in u.values()}) != 1 for u in units)
    loss = sum(not r["hookSeen"] for r in found.values()) / len(found)
    by_arm = {a: sum(bool(u[a]["pathAudit"]["hits"]) for u in units) for a in ARMS}
    contaminated = sum(by_arm.values())
    gates = dict(forkErrors=fork_errors, storeErrors=sum(not r["storeVerified"] for r in found.values()),
                 missingRequestEvidence=sum(not r["complete"] for r in found.values()),
                 neutralLeaks=sum(neutral_leak(u["N"]) for u in units), hookLoss=loss,
                 treeErrors=sum(len({(r["preTree"], r["ignoredSetup"]) for r in u.values()}) != 1 for u in units),
                 hookMissesByArm={a: sum(not u[a]["hookSeen"] for u in units) for a in ARMS},
                 contaminatedByArm=by_arm, contaminatedPairs=contaminated, scheduledPairs=len(found))
    if contaminated * 100 > 5 * len(found):
        return {**result, "status": "protocol-failure", "gates": gates}
    clean = [u for u in units if not (u["N"]["pathAudit"]["hits"] or u["T"]["pathAudit"]["hits"])]
    intact = [u for u in units if not (u["T"]["pathAudit"]["hits"] or u["Tp"]["pathAudit"]["hits"])]
    noise = gates["disagreement"] = disagreement(intact)
    violation = contrast(clean, False)
    excluded = contrast(clean, True)
    kills = []
    if violation["estimate"] < .15:
        kills.append("content")
    if noise > .15:
        kills.append("noise")
    bad = (fork_errors or gates["storeErrors"] or gates["missingRequestEvidence"] or gates["neutralLeaks"]
           or gates["treeErrors"] or loss >= .05)
    passes = all(x["low"] is not None and x["low"] > 0 and x["estimate"] >= .15
                 for x in [violation, excluded])
    status = "invalid" if bad else "kill" if kills else "audit-required" if passes else "inconclusive"
    return dict(**{**result, "status": status}, gates=gates, kill=kills, violation=violation, excluded=excluded,
                emptyCaptures=sum(u["T"]["targetCount"] == 0 for u in units),
                sensitivity=dict(violation=contrast(units, False), excluded=contrast(units, True),
                                 disagreement=disagreement(units), flaggedFollows=flagged_counts(units, True)),
                flaggedFollows=flagged_counts(units, False),
                rawGrades={a: dict(Counter(u[a]["verdict"] for u in units)) for a in ARMS})


if __name__ == "__main__":
    print(json.dumps(report(), separators=(",", ":"), allow_nan=False))
