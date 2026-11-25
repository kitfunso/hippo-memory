"""Audit the client's local request records without putting a proxy on a live fork."""
import json
from pathlib import Path

from session import CORPUS, REPAIR, read, write
from wire import fingerprint


def initial_request(folder: Path) -> tuple:
    shapes = {}
    blobs = {}
    for path in (folder / "claude-config" / "projects").glob("*/*.jsonl"):
        for line in path.read_bytes().splitlines():
            event = json.loads(line)
            if event["type"] == "api-request-shape":
                shapes[event["shapeHash"]] = event["shape"]
            elif event["type"] == "api-request-blob":
                blobs[event["hash"]] = event["message"]
            elif event["type"] == "api-request" and event["querySource"] == "sdk":
                return shapes[event["shapeHash"]], event, blobs
    raise ValueError(f"No initial SDK request recorded in {folder.name}")


def audit(folder: Path, source: dict, offline: dict) -> dict:
    shape, request, blobs = initial_request(folder)
    system = [b["text"] for b in shape["system"]]
    stable = source["system"][-1]["text"]
    old = {t["name"]: t for t in source["tools"]}
    new = {t["name"]: t for t in shape["tools"]}
    changed = {k: sorted(f for f in old[k].keys() | new[k].keys() if old[k].get(f) != new[k].get(f))
               for k in sorted(old.keys() & new.keys()) if old[k] != new[k]}
    deferred = set()
    for ref in request["tail"]:
        message = blobs.get(ref, {}) if isinstance(ref, str) else ref
        for block in message.get("content", []):
            if isinstance(block, dict) and "before calling them:\n" in block.get("text", ""):
                names = block["text"].split("before calling them:\n", 1)[1].split("\n\n", 1)[0]
                deferred.update(names.splitlines())
    extra = [b[len(stable):] for b in system if b.startswith(stable) and b != stable]
    return {"id": folder.name, "modelMatch": request["params"]["model"] == source["model"],
            "effortMatch": request["params"]["output_config"]["effort"] == source["effort"],
            "stableTextExact": stable in system, "stableTextPresent": any(stable in b for b in system),
            "appendedSystemText": extra, "toolsMatchOffline": fingerprint(shape["tools"]) == offline["toolHashes"][1],
            "toolsMissing": sorted(old.keys()-new.keys()), "toolsAdded": sorted(new.keys()-old.keys()),
            "missingAdvertisedForLookup": sorted((old.keys()-new.keys()) & deferred),
            "changedDefinitionFields": changed, "sourceMessages": len(source["messages"]),
            "liveMessages": request["keep"] + len(request["tail"])}


def main() -> None:
    offline = read(REPAIR / "wire.json")
    report = []
    ledger = REPAIR / "smoke.jsonl"
    attempts = {json.loads(line)["id"] for line in ledger.read_bytes().splitlines()} if ledger.exists() else set()
    for job in read(CORPUS / "smoke.json"):
        folder = REPAIR / job["id"]
        if job["id"] in attempts:
            try:
                report.append(audit(folder, read(CORPUS / (job["sid"]+".json")), offline))
            except ValueError as error:
                report.append({"id": job["id"], "unavailable": str(error)})
    write(REPAIR / "live-wire.json", report)
    observed = [r for r in report if "unavailable" not in r]
    print(json.dumps({"audited": len(observed), "unavailable": len(report)-len(observed),
                      "toolsMatchOffline": sum(r["toolsMatchOffline"] for r in observed),
                      "stableTextExact": sum(r["stableTextExact"] for r in observed)}))


if __name__ == "__main__":
    main()
