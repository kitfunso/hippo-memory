"""Recover the original Round 3 bodies and their billed decision-turn usage offline."""
import json
import re
from hashlib import sha256
from pathlib import Path

from session import CORPUS, ROOT, prompt_for, read


ARCHIVE = ROOT / "route-b"
ROUND3 = Path("C:/z0-runs/scored/r3run").resolve()
SONNET = "claude-sonnet-5-5"
CORPUS_SEAL = "769a5518fc7aff1672a88afdf85fc9fe17c2258315bc8efd631e143a6e3d42b9"
RECEIPTS_SEAL = "36d514ee267e335495bfb967566f313150c36b17334ab0530233d7d274b0e587"


def packed(obj: object) -> bytes:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode()


def put(path: Path, data: bytes) -> None:
    if path.exists():
        if path.read_bytes() != data:
            raise ValueError(f"Frozen file differs: {path.name}")
    else:
        with path.open("xb") as out:
            out.write(data)


def original(row: dict) -> tuple[bytes, set[str]]:
    source = Path(row["source"]).resolve()
    if not source.is_relative_to(ROUND3) or not source.name.endswith(".session1.requests.jsonl"):
        raise ValueError("Expected a Round 3 first-apply log")
    projection = (CORPUS / (row["sid"] + ".json")).read_bytes()
    if sha256(projection).hexdigest() != row["sha256"]:
        raise ValueError("Projection hash mismatch")
    saved = json.loads(projection)
    matched = None
    with source.open(encoding="utf8") as log:
        for line in log:
            record = json.loads(line)
            if not record.get("body") or not re.search(r"/v1/messages(?:\?|$)", record["url"]):
                continue
            body = json.loads(record["body"])
            if body["model"] != row["model"] or not any(t["name"] == "Bash" for t in body.get("tools", [])):
                continue
            if matched is not None:
                messages = body["messages"]
                index = max(i for i, m in enumerate(messages) if m["role"] == "assistant")
                choice = messages[index]
                ids = {b["id"] for b in choice["content"] if b["type"] == "tool_use"}
                if tool_ids(saved["messages"]) != tool_ids(messages[:index]):
                    raise ValueError("Successor history mismatch")
                if not ids:
                    raise ValueError("Missing historical decision IDs")
                return matched, ids
            if all(body[k] == saved[k] for k in ("model", "system", "tools", "messages")):
                if body.get("output_config", {}).get("effort") != saved["effort"]:
                    raise ValueError("Effort mismatch")
                matched = record["body"].encode()
                if re.search(rb"sk-ant-(?:oat|api)\d+-[\w-]{15,}", matched):
                    raise ValueError("Unexpected credential in saved body")
    raise ValueError(f"No decision/successor pair for {row['sid']}")


def tool_ids(messages: list) -> list:
    return [b["id"] for m in messages if m["role"] == "assistant" for b in m["content"] if b["type"] == "tool_use"]


def matched_usage(transcript: Path, ids: set[str]) -> dict:
    matches = {}
    needles = [i.encode() for i in ids]
    with transcript.open("rb") as lines:
        for line in lines:
            if not any(i in line for i in needles):
                continue
            record = json.loads(line)
            if record.get("type") != "assistant":
                continue
            msg = record["message"]
            for block in msg["content"]:
                if block.get("id") in ids:
                    matches[block["id"]] = (msg["id"], msg["model"], msg["usage"])
    return matches


def receipt(row: dict, ids: set[str]) -> dict:
    source = Path(row["source"])
    store = source.parents[4] / "runs" / source.parent.parent.parent.name / row["arm"] / f"seed{row['seed']}"
    project = store / "claude-config/projects"
    matches = {}
    # A retried first apply can have its wire decision in a sibling session.
    for transcript in sorted(project.glob("*/*.jsonl"), key=lambda p: (p.stem != row["sid"], p.name)):
        matches = matched_usage(transcript, ids)
        if matches:
            break
    if set(matches) != ids or len({packed(v) for v in matches.values()}) != 1:
        raise ValueError("Decision usage is ambiguous or missing")
    mid, model, usage = next(iter(matches.values()))
    if model != row["model"] or usage["output_tokens"] <= 0:
        raise ValueError("Unexpected model or missing output usage")
    return {"message": mid, "receiptSession": transcript.stem, "usage": usage}


def variant(raw: bytes, row: dict, arm: str) -> bytes:
    if arm in ("unchanged", "reference"):
        return raw
    body = json.loads(raw)
    cue = prompt_for(body, row, arm)
    if cue != "Continue.":
        if body["messages"][-1]["role"] != "user" or not cue.endswith("\nContinue."):
            raise ValueError("Unexpected reminder location")
        body["messages"][-1]["content"].append({"type": "text", "text": cue.removesuffix("\nContinue.")})
    if arm == "need-sonnet":
        body["model"] = SONNET
    return packed(body)


def freeze() -> None:
    ARCHIVE.mkdir(exist_ok=True)
    bodies = ARCHIVE / "bodies"
    bodies.mkdir(exist_ok=True)
    index = {}
    if sha256((CORPUS / "seal.json").read_bytes()).hexdigest() != CORPUS_SEAL:
        raise ValueError("Corpus seal differs from registration")
    seal = read(CORPUS / "seal.json")
    for name in ("manifest.json", "smoke.json", "gate.json", "treatment.json"):
        if sha256((CORPUS / name).read_bytes()).hexdigest() != seal[name]:
            raise ValueError("Schedule or manifest changed")
    for row in read(CORPUS / "manifest.json"):
        raw, ids = original(row)
        result = receipt(row, ids)
        result.update(bytes=len(raw), sha256=sha256(raw).hexdigest())
        put(bodies / (row["sid"] + ".json"), raw)
        index[row["sid"]] = result
    if sha256(packed(index)).hexdigest() != RECEIPTS_SEAL:
        raise ValueError("Decision receipts differ from registration")
    put(ARCHIVE / "receipts.json", packed(index))
    print(f"Recovered {len(index)} decision bodies and matched response receipts")


if __name__ == "__main__":
    freeze()
