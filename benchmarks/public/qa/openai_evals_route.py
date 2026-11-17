"""HaluMem's official-setup gpt-4o calls as one OpenAI Evals run, and the run's replies back into the runner's call log.

render: one row per question holding the messages the runner's own OpenAIChat._body posts, read through item_reference
so no template touches the text, plus the eval and run bodies. send uploads and starts the run, fetch saves its output
items, ingest appends each reply to a call log as an ask, so halumem_openai.py judge and score read it unchanged.
Usage (runner venv): python -I openai_evals_route.py render --variant long --arm hippo-emb --stage answer --out DIR
[--limit N | --qid Q ...] [--model M]; send DIR --shared; fetch DIR; ingest DIR --log CALLS.jsonl
"""
from __future__ import annotations

import argparse
import dataclasses
import json
import sys
import time
from collections import Counter
from pathlib import Path
from types import SimpleNamespace
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from openai import OpenAI

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE.parent / "mem0"), str(HERE.parent)]
import halumem_openai as ho  # noqa: E402
from qa.ledger import Item, Manifest, hash16, one_writer  # noqa: E402
from qa.openai_llm import EFFORT, PRICES, OpenAIChat, Settings, api_key, cost  # noqa: E402

ROUTE = "openai-evals"
# Each chat completions field the runner posts, by its sampling_params name; render stops on any other field.
# The API takes max_completions_tokens, as the docs' curl example spells it, and 400s the reference's spelling (17 Nov).
PARAMS = {"temperature": "temperature", "max_tokens": "max_completions_tokens",
          "max_completion_tokens": "max_completions_tokens", "response_format": "response_format"}
CHECKED = ("temperature", "max_completions_tokens")  # the settings an output item's sample reports, by these names
MESSAGE = {"type": "object", "properties": {"role": {"type": "string"}, "content": {"type": "string"}},
           "required": ["role", "content"]}
ITEM_SCHEMA = {"type": "object", "required": ["tag", "sys", "user", "messages"],
               "properties": {"tag": {"type": "string"}, "sys": {"type": "string"}, "user": {"type": "string"},
                              "messages": {"type": "array", "items": MESSAGE}}}
# testing_criteria is required; a string check calls no model, so grading adds no cost
GRADER = {"type": "string_check", "name": "replied", "input": "{{ sample.output_text }}", "reference": "",
          "operation": "ne"}
DONE = ("completed", "failed", "canceled")


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_bytes().split(b"\n") if line.strip()]


def wire(settings: Settings, item: Item) -> dict:
    """The chat completions body the runner posts for this item, built by the runner's own code."""
    return json.loads(OpenAIChat._body(SimpleNamespace(settings=settings), item.system, item.user))


def run_config(bodies: list[dict]) -> tuple[str, dict]:
    """The model and sampling_params every row shares; stops when rows differ or a field has no sampling_params name."""
    rest = {json.dumps({k: v for k, v in b.items() if k != "messages"}, sort_keys=True) for b in bodies}
    if len(rest) != 1:
        sys.exit(f"rows differ in model or settings: {sorted(rest)[:2]}")
    shared = json.loads(rest.pop())
    model = shared.pop("model")
    if unknown := sorted(set(shared) - set(PARAMS)):
        sys.exit(f"an eval run has no sampling_params field for {unknown}")
    return model, {PARAMS[k]: v for k, v in shared.items()}


def render(items: dict[str, Item], settings: Settings, out: Path, name: str) -> dict:
    """Writes rows.jsonl, eval.json, run.json and route.json into out; returns route.json."""
    if (out / "sent.json").exists():
        sys.exit(f"{out / 'sent.json'} exists: that run was sent; render into a new folder")
    bodies = {k: wire(settings, it) for k, it in items.items()}
    model, params = run_config(list(bodies.values()))
    rows = [{"item": {"tag": it.tag, "sys": hash16(it.system), "user": hash16(it.user),
                      "messages": bodies[k]["messages"]}} for k, it in items.items()]
    route = {"name": name, "model": model, "sampling_params": params, "rows": len(rows),
             "manifest": dataclasses.asdict(Manifest(settings.model, EFFORT, settings.cli))}
    run = {"name": name, "data_source": {
        "type": "completions", "model": model, "sampling_params": params,
        "input_messages": {"type": "item_reference", "item_reference": "item.messages"},
        "source": {"type": "file_id", "id": ""}}}  # send fills in the uploaded rows file
    ev = {"name": name, "data_source_config": {"type": "custom", "item_schema": ITEM_SCHEMA,
                                               "include_sample_schema": True}, "testing_criteria": [GRADER]}
    out.mkdir(parents=True, exist_ok=True)
    (out / "rows.jsonl").write_bytes(b"".join(json.dumps(r, ensure_ascii=False).encode("utf-8") + b"\n" for r in rows))
    for fname, obj in (("eval.json", ev), ("run.json", run), ("route.json", route)):
        (out / fname).write_text(json.dumps(obj, indent=1), encoding="utf-8")
    return route


def stage_items(a: argparse.Namespace) -> dict[str, Item]:
    """The runner's own items for the stage: answers from its retrievals, judges from the answers its log settles."""
    mod = ho.loader(a.variant)
    qs = [q for q in mod.questions() if q["qid"] in a.qid] if a.qid else mod.questions()[:a.limit]
    if a.stage == "answer":
        return ho.answer_items(mod, a.variant, a.arm, qs)
    ledger_dir = ho.OUT / a.variant / a.arm
    return ho.judge_items(mod, a.variant, a.arm, qs, ho.answers_of(mod, a.variant, a.arm, ledger_dir, qs))


def client(retries: int) -> OpenAI:
    from openai import OpenAI  # the runner venv's SDK; render and ingest never need it
    return OpenAI(api_key=api_key(), max_retries=retries)


def send(d: Path, shared: bool) -> None:
    if not shared:
        sys.exit("turn on evaluation data sharing for this project in the org's data controls (help.openai.com "
                 "article 10306912), then pass --shared; without it the run bills at standard rates")
    path = d / "sent.json"
    sent = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    if "run_id" in sent:
        sys.exit(f"{path} holds run {sent['run_id']}: fetch it, or render into a new folder")
    c = client(0)  # no automatic retry: a create retried after a timeout could start a second run

    def keep(**ids: str) -> None:  # each id as soon as it exists, so a failed step resumes and orphans nothing
        sent.update(ids)
        path.write_text(json.dumps(sent, indent=1), encoding="utf-8")

    if "eval_id" not in sent:
        keep(eval_id=c.evals.create(**json.loads((d / "eval.json").read_text(encoding="utf-8"))).id)
    if "file_id" not in sent:
        with (d / "rows.jsonl").open("rb") as f:
            keep(file_id=c.files.create(file=f, purpose="evals").id)
    run = json.loads((d / "run.json").read_text(encoding="utf-8"))
    run["data_source"]["source"]["id"] = sent["file_id"]
    r = c.evals.runs.create(sent["eval_id"], **run)
    keep(run_id=r.id, status=r.status, report_url=r.report_url)
    print(json.dumps(sent))


def fetch(d: Path) -> int:
    """The run's state as one JSON line; once it is done, every output item into output-items.jsonl. 3: not done."""
    sent, c = json.loads((d / "sent.json").read_text(encoding="utf-8")), client(2)
    run = c.evals.runs.retrieve(sent["run_id"], eval_id=sent["eval_id"]).model_dump()
    (d / "run-final.json").write_text(json.dumps(run, indent=1), encoding="utf-8")
    # shared_with_openai is undocumented and the only sign of the free tier: true on gpt-4o-mini, false on gpt-4o (17 Nov)
    state = {k: run.get(k) for k in ("status", "shared_with_openai", "result_counts", "per_model_usage", "error")}
    if run["status"] in DONE:
        items = c.evals.runs.output_items.list(sent["run_id"], eval_id=sent["eval_id"], limit=100)
        lines = [json.dumps(i.model_dump(), ensure_ascii=False).encode("utf-8") + b"\n" for i in items]
        (d / "output-items.jsonl").write_bytes(b"".join(lines))
        state["items"] = len(lines)
    print(json.dumps(state))
    return 0 if "items" in state else 3


def differs(sample: dict, row: dict, route: dict) -> str | None:
    """Why the run did not send this row as rendered, or None."""
    got = [(m.get("role"), m.get("content")) for m in sample.get("input") or []]
    if got != [(m["role"], m["content"]) for m in row["messages"]]:
        return "the input messages differ from the rendered row"
    if sample.get("model") != route["model"]:
        return f"model {sample.get('model')!r}, not {route['model']!r}"
    for k in CHECKED:
        if k in route["sampling_params"] and sample.get(k) != route["sampling_params"][k]:
            return f"{k} {sample.get(k)!r}, not {route['sampling_params'][k]!r}"
    return None


def record_of(out: dict, row: dict, route: dict, sent: dict) -> tuple[str, dict | None]:
    """The call-log record for one output item, in claude_llm's shape: an ask when the run sent the row as rendered,
    an error (no ask, as the runner logs one) when it returned no text, None when it sent something else."""
    s, man = out.get("sample") or {}, route["manifest"]
    text = next((m.get("content") or "" for m in s.get("output") or [] if m.get("role", "assistant") == "assistant"), "")
    base = {"tag": row["tag"], "sys": row["sys"], "user": row["user"], "effort": man["effort"], "cli": man["cli"],
            "attempt": 1, "wall_ms": None, "route": ROUTE, "eval_id": sent["eval_id"], "run_id": sent["run_id"],
            "output_item_id": out["id"]}
    if s.get("error") or not text.strip():
        return "error", {**base, "event": "error", "detail": f"{s.get('error')} {s.get('finish_reason')}"[:400]}
    if why := differs(s, row, route):
        return f"refused: {why}", None
    u = s.get("usage") or {}
    usage = {"prompt_tokens": u.get("prompt_tokens"), "completion_tokens": u.get("completion_tokens"),
             "total_tokens": u.get("total_tokens"), "prompt_tokens_details": {"cached_tokens": u.get("cached_tokens")}}
    return "ok", {**base, "event": "ok", "models": [s["model"]], "usage": usage,
                  "cost_usd_list": cost(s["model"], usage) if s["model"] in PRICES else None, "api_ms": None,
                  "waited_s": 0, "text": text, "finish_reason": s.get("finish_reason"), "seed": s.get("seed")}


def ingest(d: Path, log: Path) -> int:
    """Appends each output item not yet in the log; 1 when any item was refused."""
    route, sent = (json.loads((d / f).read_text(encoding="utf-8")) for f in ("route.json", "sent.json"))
    rows = {(r["item"]["tag"], r["item"]["user"]): r["item"] for r in read_jsonl(d / "rows.jsonl")}
    counts: Counter = Counter()
    with one_writer(log.parent):
        seen = {r.get("output_item_id") for r in read_jsonl(log) if r.get("route") == ROUTE} if log.exists() else set()
        recs = []
        for out in read_jsonl(d / "output-items.jsonl"):
            item = out.get("datasource_item") or {}
            row = rows.get((item.get("tag"), item.get("user")))
            kind, rec = ("refused: not a rendered row", None) if row is None else record_of(out, row, route, sent)
            kind = "already in the log" if out["id"] in seen else kind
            counts[kind] += 1
            if rec and kind in ("ok", "error"):
                recs.append(json.dumps({**rec, "ts": round(time.time(), 3)}, ensure_ascii=False) + "\n")
        with log.open("a", encoding="utf-8") as f:
            f.writelines(recs)
    print(json.dumps(dict(counts)))
    return 1 if any(k.startswith("refused") for k in counts) else 0


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("render")
    r.add_argument("--variant", choices=("medium", "long"), required=True)
    r.add_argument("--arm", choices=tuple(ho.ARMS), required=True)
    r.add_argument("--stage", choices=("answer", "judge"), required=True)
    r.add_argument("--out", type=Path, required=True)
    r.add_argument("--limit", type=int, help="the first N questions")
    r.add_argument("--qid", action="append", help="only these questions")
    r.add_argument("--model", default=ho.GPT4O.model, help="a smoke on another model; every other setting stays")
    for name in ("send", "fetch", "ingest"):
        p = sub.add_parser(name)
        p.add_argument("dir", type=Path)
    sub.choices["send"].add_argument("--shared", action="store_true", help="evaluation data sharing is on")
    sub.choices["ingest"].add_argument("--log", type=Path, required=True, help="the call log to append to")
    a = ap.parse_args()
    if a.cmd == "render":
        settings = dataclasses.replace(ho.GPT4O, model=a.model)
        name = f"hippo halumem-{a.variant} {a.stage} {a.arm} {a.model}"
        print(json.dumps({"out": str(a.out), **render(stage_items(a), settings, a.out, name)}))
    elif a.cmd == "send":
        send(a.dir, a.shared)
    else:
        sys.exit(fetch(a.dir) if a.cmd == "fetch" else ingest(a.dir, a.log))


if __name__ == "__main__":
    main()
