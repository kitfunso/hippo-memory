"""Exercise the registered decisions on invented grades outside the scored input."""
import json
import subprocess
import tempfile
from pathlib import Path

import analyze


def verify() -> None:
    plan = json.loads(subprocess.check_output(["node", str(analyze.PLAN)], encoding="utf-8"))
    labels = json.loads(subprocess.check_output(["node", str(analyze.PLAN), "labels"], encoding="utf-8"))
    with tempfile.TemporaryDirectory(dir=analyze.ROOT.parent, prefix="analysis-test-") as directory:
        analyze.ROOT = Path(directory)
        assert analyze.report() == {"planned": 147, "observed": 0, "status": "incomplete"}
        files = {}
        for unit, _, _, order in plan["units"]:
            for index, arm in enumerate(order):
                record = dict(id=unit, arm=arm, repo=unit.split("-")[0], mode="unit", session=unit+arm,
                              teachId=unit, snapshotHash=unit, resetHash=unit, targetCount=1, storeVerified=True,
                              verdict="fail" if arm == "N" else "pass", hookSeen=True, complete=True,
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
        files[first, "T"].unlink()
        assert analyze.report()["status"] == "incomplete"
    print("Passed synthetic contrasts, variant denominator, missing hook, leak, kill and incomplete roster.")


if __name__ == "__main__":
    verify()
