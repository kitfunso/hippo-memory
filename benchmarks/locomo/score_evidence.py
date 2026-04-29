"""Rescore LoCoMo result JSONs with deterministic gold evidence recall@K."""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path
from typing import Any

from run import (
    CATEGORY_NAMES,
    collect_turns,
    dia_ids_from_memory,
    normalize_evidence_refs,
    score_evidence_overlap,
)

DEFAULT_DATA = Path(__file__).resolve().parent / "data" / "locomo10.json"


def expected_answer_for_match(qa: dict[str, Any]) -> str:
    if qa.get("category") == 5:
        return str(qa.get("adversarial_answer", ""))
    return str(qa.get("answer", ""))


def content_keys(content: Any) -> list[str]:
    text = str(content)
    keys = [text]
    stripped = text.strip()
    collapsed = " ".join(text.split())
    for key in (stripped, collapsed):
        if key and key not in keys:
            keys.append(key)
    return keys


def build_indexes(data: list[dict[str, Any]]) -> tuple[
    dict[str, dict[str, list[dict[str, Any]]]],
    dict[str, list[dict[str, Any]]],
    dict[str, dict[str, list[str]]],
    dict[str, set[str]],
]:
    qa_by_question: dict[str, dict[str, list[dict[str, Any]]]] = defaultdict(lambda: defaultdict(list))
    qa_by_index: dict[str, list[dict[str, Any]]] = {}
    content_to_dia: dict[str, dict[str, list[str]]] = defaultdict(lambda: defaultdict(list))
    valid_dia_ids: dict[str, set[str]] = defaultdict(set)

    for entry in data:
        sample_id = str(entry.get("sample_id", ""))
        qas = list(entry.get("qa", []))
        qa_by_index[sample_id] = qas
        for qa in qas:
            qa_by_question[sample_id][str(qa.get("question", ""))].append(qa)
        for _, dia_id, _, content in collect_turns(entry.get("conversation", {})):
            if not dia_id:
                continue
            valid_dia_ids[sample_id].add(dia_id)
            for key in content_keys(content):
                if dia_id not in content_to_dia[sample_id][key]:
                    content_to_dia[sample_id][key].append(dia_id)

    return qa_by_question, qa_by_index, content_to_dia, valid_dia_ids


def row_matches_qa(row: dict[str, Any], qa: dict[str, Any]) -> bool:
    return (
        str(row.get("question", "")) == str(qa.get("question", ""))
        and row.get("category") == qa.get("category")
        and str(row.get("expected_answer", "")) == expected_answer_for_match(qa)
    )


def match_qa(
    row: dict[str, Any],
    qa_by_question: dict[str, dict[str, list[dict[str, Any]]]],
    qa_by_index: dict[str, list[dict[str, Any]]],
) -> dict[str, Any] | None:
    sample_id = str(row.get("conversation_id", ""))
    try:
        qa_index = int(row.get("qa_index"))
    except (TypeError, ValueError):
        qa_index = -1
    indexed_qas = qa_by_index.get(sample_id, [])
    if 0 <= qa_index < len(indexed_qas) and row_matches_qa(row, indexed_qas[qa_index]):
        return indexed_qas[qa_index]

    question = str(row.get("question", ""))
    candidates = qa_by_question.get(sample_id, {}).get(question, [])
    if len(candidates) == 1:
        return candidates[0]

    category = row.get("category")
    expected = str(row.get("expected_answer", ""))
    exact = [
        qa for qa in candidates
        if qa.get("category") == category and expected_answer_for_match(qa) == expected
    ]
    if len(exact) == 1:
        return exact[0]
    if exact:
        return exact[0]
    return candidates[0] if candidates else None


def attach_dia_ids(
    memory: dict[str, Any],
    content_to_dia: dict[str, list[str]],
) -> dict[str, Any]:
    dia_ids = dia_ids_from_memory(memory)
    content = memory.get("content", "")
    if not dia_ids:
        for key in content_keys(content):
            dia_ids = content_to_dia.get(key, [])
            if dia_ids:
                break
    if not dia_ids:
        collapsed = " ".join(str(content).split())
        if len(collapsed) >= 80:
            matches: list[str] = []
            for key, ids in content_to_dia.items():
                if key.startswith(collapsed) or collapsed.startswith(key):
                    for dia_id in ids:
                        if dia_id not in matches:
                            matches.append(dia_id)
            if len(matches) == 1:
                dia_ids = matches
    tags = memory.get("tags", [])
    if not isinstance(tags, list):
        tags = []
    return {
        "content": content,
        "score": memory.get("score", 0.0),
        "tags": [str(tag) for tag in tags],
        "dia_ids": list(dia_ids),
    }


def aggregate(rows: list[dict[str, Any]]) -> dict[str, Any]:
    scored = [row for row in rows if row.get("scored", True)]
    total = len(scored)
    if total == 0:
        return {"overall": {"total": 0, "mean_score": 0.0}, "per_category": {}}

    by_cat: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in scored:
        by_cat[int(row.get("category", 0))].append(row)

    def score(row: dict[str, Any]) -> float:
        return float(row.get("score", 0.0))

    per_category = {}
    for category, cat_rows in sorted(by_cat.items()):
        per_category[CATEGORY_NAMES.get(category, f"cat{category}")] = {
            "total": len(cat_rows),
            "mean_score": sum(score(row) for row in cat_rows) / len(cat_rows),
            "n_equivalent": sum(1 for row in cat_rows if score(row) == 1.0),
            "n_partial": sum(1 for row in cat_rows if 0.0 < score(row) < 1.0),
            "n_wrong": sum(1 for row in cat_rows if score(row) == 0.0),
            "n_unscored": sum(
                1 for row in rows
                if int(row.get("category", 0)) == category and not row.get("scored", True)
            ),
        }

    return {
        "overall": {
            "total": total,
            "mean_score": sum(score(row) for row in scored) / total,
            "n_equivalent": sum(1 for row in scored if score(row) == 1.0),
            "n_partial": sum(1 for row in scored if 0.0 < score(row) < 1.0),
            "n_wrong": sum(1 for row in scored if score(row) == 0.0),
            "n_unscored": len(rows) - total,
        },
        "per_category": per_category,
    }


def rescore(data_path: Path, result_path: Path, output_path: Path, top_k: int | None) -> dict[str, Any]:
    data = json.loads(data_path.read_text(encoding="utf-8"))
    report = json.loads(result_path.read_text(encoding="utf-8"))
    qa_by_question, qa_by_index, content_to_dia, valid_dia_ids = build_indexes(data)

    configured_top_k = int(report.get("config", {}).get("top_k", 5))
    effective_top_k = top_k or configured_top_k
    rows: list[dict[str, Any]] = []
    unmatched_rows: list[dict[str, Any]] = []
    total_memories = 0
    memories_without_dia_ids = 0
    unmatched_gold_refs = 0

    for source_row in report.get("per_qa", []):
        row = dict(source_row)
        qa = match_qa(row, qa_by_question, qa_by_index)
        sample_id = str(row.get("conversation_id", ""))
        memories = [
            attach_dia_ids(memory, content_to_dia.get(sample_id, {}))
            for memory in row.get("top_k_memories", [])[:effective_top_k]
        ]
        total_memories += len(memories)
        memories_without_dia_ids += sum(1 for memory in memories if not memory.get("dia_ids"))
        row["top_k_memories"] = memories
        row["original_judge_verdict"] = row.get("judge_verdict")
        row["original_score"] = row.get("score")

        if qa is None:
            row["gold_evidence"] = []
            row["gold_evidence_unmatched"] = []
            row["retrieved_dia_ids"] = [
                dia_id
                for memory in memories
                for dia_id in dia_ids_from_memory(memory)
            ]
            row["evidence_hits"] = []
            row["evidence_recall"] = None
            row["evidence_precision"] = None
            row["judge_verdict"] = "evidence_unmatched_qa"
            row["score"] = 0.0
            row["scored"] = False
            unmatched_rows.append(row)
            rows.append(row)
            continue

        refs = normalize_evidence_refs(qa.get("evidence", []))
        valid_refs = [ref for ref in refs if ref in valid_dia_ids.get(sample_id, set())]
        invalid_refs = [ref for ref in refs if ref not in valid_dia_ids.get(sample_id, set())]
        unmatched_gold_refs += len(invalid_refs)
        verdict, score, retrieved, hits, recall, precision, scored = score_evidence_overlap(
            valid_refs,
            memories,
            effective_top_k,
        )
        row["gold_evidence"] = valid_refs
        row["gold_evidence_unmatched"] = invalid_refs
        row["retrieved_dia_ids"] = retrieved
        row["evidence_hits"] = hits
        row["evidence_recall"] = recall
        row["evidence_precision"] = precision
        row["judge_verdict"] = verdict
        row["score"] = score
        row["scored"] = scored
        rows.append(row)

    rescored = dict(report)
    config = dict(report.get("config", {}))
    config.update({
        "score_mode": "evidence",
        "top_k": effective_top_k,
        "source_result": str(result_path),
    })
    rescored["config"] = config
    rescored["judge_model"] = "none"
    rescored["aggregate"] = aggregate(rows)
    rescored["per_qa"] = rows
    rescored["evidence_rescore"] = {
        "source_result": str(result_path),
        "unmatched_qa_rows": len(unmatched_rows),
        "unmatched_gold_refs": unmatched_gold_refs,
        "memory_results_total": total_memories,
        "memory_results_without_dia_ids": memories_without_dia_ids,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(rescored, indent=2, ensure_ascii=False), encoding="utf-8")
    return rescored


def main() -> None:
    parser = argparse.ArgumentParser(description="Deterministically rescore a LoCoMo result JSON by gold evidence recall@K.")
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA)
    parser.add_argument("--result", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--top-k", type=int, default=None)
    args = parser.parse_args()

    rescored = rescore(args.data, args.result, args.output, args.top_k)
    print(json.dumps(rescored["aggregate"], indent=2))


if __name__ == "__main__":
    main()
