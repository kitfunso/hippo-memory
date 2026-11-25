"""Exercise the registered decisions on invented grades outside the scored input."""
import json
import subprocess
import shutil
from uuid import uuid4
from pathlib import Path

import analyze


def refused(text: str) -> None:
    try:
        analyze.read_roster()
    except ValueError as error:
        assert text in str(error), error
        return
    raise AssertionError("Accepted a receipt that needs " + text)


def regrade_cases(plan: dict, labels: dict, files: dict) -> None:
    unit = plan["units"][1][0]
    path = files[unit, "N"]
    record = json.loads(path.read_text(encoding="utf-8"))
    path.write_text(json.dumps({k: v for k, v in record.items() if k != "grader"}), encoding="utf-8")
    refused("offline regrade")
    verdict = "fail" if record["verdict"] == "pass" else "pass"
    flagged = False if unit in labels["variant"] else None
    path.with_name("regrade.json").write_text(json.dumps(dict(grader=analyze.GRADER, id=unit, arm="N",
        session=record["session"], verdict=verdict, flagged=flagged)), encoding="utf-8")
    teach = path.parents[2] / "regrade-teach.json"
    form = lambda found: json.dumps(dict(grader=analyze.GRADER, id=unit, form=found, recordedForm="correction"))
    teach.write_text(form("correction"), encoding="utf-8")
    assert analyze.read_roster()[1][unit, "N"]["verdict"] == verdict
    teach.write_text(form("confirmation"), encoding="utf-8")
    refused("recollect")
    teach.unlink()
    path.with_name("regrade.json").unlink()
    path.write_text(json.dumps(record), encoding="utf-8")


def verify() -> None:
    plan = json.loads(subprocess.check_output(["node", str(analyze.PLAN)], encoding="utf-8"))
    labels = json.loads(subprocess.check_output(["node", str(analyze.PLAN), "labels"], encoding="utf-8"))
    original = analyze.ROOT
    directory = Path.cwd() / f"knockout-analysis-{uuid4().hex}"
    directory.mkdir()
    try:
        analyze.ROOT = directory
        assert analyze.report() == {"planned": 147, "observed": 0, "status": "incomplete"}
        files = {}
        for unit, _, _, order in plan["units"]:
            for index, arm in enumerate(order):
                record = dict(id=unit, arm=arm, repo=unit.split("-")[0], mode="unit", session=unit+arm,
                              teachId=unit, snapshotHash=unit, resetHash=unit, targetCount=1, storeVerified=True,
                              verdict="fail" if arm == "N" else "pass", hookSeen=True, complete=True,
                              pathAudit={"transcripts": 1, "hits": []}, grader=analyze.GRADER,
                              targetText=arm != "N", flagged=(arm == "N") if unit in labels["variant"] else None)
                path = analyze.ROOT / unit / "evidence" / f"apply-{index}" / "grade.json"
                path.parent.mkdir(parents=True)
                path.write_text(json.dumps(record), encoding="utf-8")
                files[unit, arm] = path
        def change(unit: str, arm: str, **fields: object) -> None:
            path = files[unit, arm]
            path.write_text(json.dumps({**json.loads(path.read_text()), **fields}), encoding="utf-8")

        report = analyze.report()
        assert report["status"] == "audit-required" and report["violation"]["estimate"] == 1
        assert report["flaggedFollows"]["N"] == {"eligible": len(labels["variant"]), "flagged": len(labels["variant"])}
        first = plan["units"][0][0]
        hit = {"transcripts": 2, "hits": [{"tool": "Read"}, {"tool": "Bash"}]}
        clean = {"transcripts": 1, "hits": []}
        change(first, "N", pathAudit=hit, verdict="pass")
        report = analyze.report()
        assert report["gates"]["contaminatedByArm"] == {"T": 0, "Tp": 0, "N": 1}
        assert report["violation"]["pairs"] == len(plan["units"])-1 and report["violation"]["estimate"] == 1
        assert report["sensitivity"]["violation"]["pairs"] == len(plan["units"])
        assert report["sensitivity"]["violation"]["estimate"] < 1
        for unit, *_ in plan["units"][:6]:
            change(unit, "Tp", pathAudit=hit, verdict="fail")
        report = analyze.report()
        assert report["status"] == "audit-required" and report["gates"]["disagreement"] == 0
        assert report["sensitivity"]["disagreement"] > 0
        change(first, "T", pathAudit=hit)
        report = analyze.report()
        assert report["status"] == "protocol-failure" and report["gates"]["contaminatedPairs"] == 8
        assert not {"violation", "excluded", "sensitivity", "kill"} & report.keys()
        assert "disagreement" not in report["gates"]
        for unit, *_ in plan["units"][:6]:
            change(unit, "Tp", pathAudit=clean, verdict="pass")
        change(first, "T", pathAudit=clean)
        change(first, "N", pathAudit=clean, verdict="fail")
        change(first, "N", targetText=True)
        assert analyze.report()["status"] == "invalid"
        change(first, "N", targetText=False, verdict="na", hookSeen=False)
        report = analyze.report()
        assert report["status"] == "audit-required" and report["excluded"]["pairs"] == len(plan["units"])-1
        assert report["gates"]["hookMissesByArm"]["N"] == 1
        for unit, *_ in plan["units"][:8]:
            change(unit, "T", hookSeen=False)
        assert analyze.report()["status"] == "invalid"
        for unit, *_ in plan["units"]:
            change(unit, "T", hookSeen=True, verdict="fail")
        report = analyze.report()
        assert report["status"] == "kill" and report["kill"] == ["content", "noise"]
        regrade_cases(plan, labels, files)
        files[first, "T"].unlink()
        assert analyze.report()["status"] == "incomplete"
    finally:
        analyze.ROOT = original
        shutil.rmtree(directory)
    print("Passed synthetic rosters, including pair exclusions, all-pair sensitivity, the protocol failure gate and offline regrades.")


if __name__ == "__main__":
    verify()
