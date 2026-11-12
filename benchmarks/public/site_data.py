"""Benchmarks-page data: hippo's answer scores and its paired rivals from the score files, published rows from competitors.json.

Usage: python benchmarks/public/site_data.py [results dir]   (writes website/src/data/public-benchmarks.json)
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RESULTS = ROOT / "benchmarks/public/results/2026-11-12-answer-accuracy"
OUT = ROOT / "website/src/data/public-benchmarks.json"
PAIR = r"\s*{metric}:\s+([+-][\d.]+) pp \[\s*([+-][\d.]+),\s*([+-][\d.]+)\] n=(\d+)"
# name, score-file stem, hippo's value pattern, the paired-line prefix and metric, the unit shown, hippo's settings answered at
# the card's cutoff. The card shows the higher setting and names it; LoCoMo and LongMemEval-S ran hippo-best only at 50 and 10.
BENCHES = [
    ("LoCoMo", "locomo-h2h", r"=== top 200 ===\n{arm}\s+n=\d+\s+F1\s+[\d.]+\s+judge\s+([\d.]+)", "top 200 ", "judge", "%", ("hippo-emb",)),
    ("LongMemEval-S", "longmemeval-s", r"{arm}\s+acc@200\s+n=\d+\s+mean\s+([\d.]+)", "secondary acc@200 ", "", "%", ("hippo-emb",)),
    ("PersonaMem v1", "personamem_v1", r"{arm}\s+accuracy\s+([\d.]+)", "secondary ", "", "%", ("hippo-emb", "hippo-best")),
    ("DMR", "dmr", r"{arm}\s+accuracy\s+([\d.]+)", "secondary ", "", "%", ("hippo-emb", "hippo-best")),
    ("HotPotQA-24 (Cognee)", "hotpotqa24", r"{arm}\s+EM\s+[\d.]+\s+F1\s+([\d.]+)", "secondary ", " F1", "F1", ("hippo-emb", "hippo-best")),
]
SETTING = {"hippo-emb": "local embedder", "hippo-best": "local embedder and reranker"}
ARM = {"hippo365": "hippo, embeddings off", "hippo-emb": "hippo, embedder only", "bm25": "BM25", "mem0": "Mem0",
       "full": "Full chat"}
MEMORY_SYSTEMS_HERE = {"Mem0"}  # rivals run here that are memory products; BM25 and full chat are controls
SKIP = re.compile(r"recall|R@|not answer accuracy|retrieval|^F1$|DeepEval", re.I)  # measures other than answer accuracy
FOLD = {"Mem0g": "Mem0", "Mastra RAG": "Mastra", "Mastra Observational Memory": "Mastra"}  # one row per vendor


def value(score: str) -> float | None:
    """A published row's best figure: per ';' segment the first percentage (the top of an 'X% to Y%' range)."""
    best = None
    for seg in score.replace(",", "").split(";"):
        pct = [float(x) for x in re.findall(r"(\d+(?:\.\d+)?)%", seg)]
        if pct:
            v = max(pct[:2]) if re.search(r"\d%\s*to\s*\d", seg) else pct[0]
        else:
            m = re.search(r"F1 (\d+(?:\.\d+)?)", seg) or re.search(r"(\d+(?:\.\d+)?)", seg)
            v = float(m.group(1)) if m else None
        if v is not None and v <= 100:
            best = v if best is None else max(best, v)
    return best


def product(name: str) -> str:
    if name.lower().startswith("full"):
        return "Full chat"
    base = re.sub(r"-\d+$", "", re.split(r" \(| / | v\d", name)[0].strip())
    return FOLD.get(base, base)


def ours(text: str, pattern: str, prefix: str, metric: str, arm: str) -> tuple[float, list[dict], int]:
    m = re.search(pattern.format(arm=arm), text, re.M)
    if not m:
        sys.exit(f"hippo's score line not found ({pattern}, {arm}): the score file format changed, update BENCHES")
    pair = re.compile(rf"^{prefix}{arm} - ([\w-]+) \(([\d.]+) in [\w-]+\)" + PAIR.format(metric=metric), re.M)
    rivals = [{"name": ARM[a], "value": float(v), "diff": float(d), "lo": float(lo), "hi": float(hi)}
              for a, v, d, lo, hi, _ in pair.findall(text)]
    ns = {int(n) for *_, n in pair.findall(text)}
    if not rivals or len(ns) != 1:
        sys.exit(f"paired lines missing or with mixed question counts {ns}: check the score file")
    return float(m.group(1)), rivals, ns.pop()


def published(rows: list[dict], bench: str) -> list[dict]:
    best: dict[str, dict] = {}
    for r in rows:
        if r["benchmark"] != bench or r["kind"] == "ours" or SKIP.search(r["metric"].strip()):
            continue
        v = value(r["score"])
        if v is None:
            continue
        name = product(r["system"])
        if name not in best or v > best[name]["value"]:
            best[name] = {"name": name, "system": r["system"], "value": v, "kind": r["kind"], "src": r["url"]}
    return sorted(best.values(), key=lambda p: -p["value"])


def rank(hippo: float, rivals: list[dict], pub: list[dict]) -> tuple[int, int] | None:
    """hippo's place among memory systems: each vendor's best, published or run here; controls and models alone left out."""
    field: dict[str, float] = {}
    for p in pub:
        if p["kind"] == "product" and p["name"] != "Full chat":
            field[p["name"]] = max(field.get(p["name"], 0), p["value"])
    for r in rivals:
        if r["name"] in MEMORY_SYSTEMS_HERE:
            field[r["name"]] = max(field.get(r["name"], 0), r["value"])
    return (1 + sum(v > hippo for v in field.values()), len(field) + 1) if field else None


def main() -> None:
    res = Path(sys.argv[1]) if len(sys.argv) > 1 else RESULTS
    comp = json.loads((res / "competitors.json").read_text(encoding="utf-8"))["rows"]
    gate = json.loads((res / "mem0-locomo-ingest-gate.json").read_text(encoding="utf-8"))
    calls = re.search(r"'ok': (\d+)", next(l for l in gate["lines"] if "extraction calls" in l))
    if not gate["pass"] or not calls:
        sys.exit("mem0-locomo-ingest-gate.json: the gate did not pass or has no extraction-call count")
    rel = res.resolve().relative_to(ROOT).as_posix()
    benches = []
    for name, stem, pattern, prefix, metric, unit, arms in BENCHES:
        files = {arm: f"{stem}-{arm.removeprefix('hippo-')}.txt" for arm in arms}
        scored = {arm: ours((res / f).read_text(encoding="utf-8"), pattern, prefix, metric, arm) for arm, f in files.items()}
        arm = max(arms, key=lambda a: scored[a][0])
        hippo, rivals, n = scored[arm]
        pub = published(comp, name)
        place = rank(hippo, rivals, pub)
        benches.append({"name": name, "unit": unit, "n": n, "hippo": hippo, "setting": SETTING[arm], "file": f"{rel}/{files[arm]}",
                        "rivals": rivals, "published": pub, "rank": place[0] if place else None,
                        "field": place[1] if place else None})
        print(json.dumps({"bench": name, "hippo": hippo, "setting": SETTING[arm], "n": n, "rank": place, "rivals": len(rivals),
                          "published": len(pub)}))
    out = {"answerModel": "Claude Sonnet 5", "receipts": rel, "benches": benches,
           "storeCalls": {"bench": "LoCoMo", "mem0": int(calls.group(1)), "hippo": 0,
                          "file": f"{rel}/mem0-locomo-ingest-gate.json"}}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"wrote": OUT.relative_to(ROOT).as_posix()}))


if __name__ == "__main__":
    main()
