#!/usr/bin/env python3
"""F10 (Track 3) enrichment driver.

Two subcommands:
  build-batches: split LongMemEval sessions into per-batch JSON files
                 (input to Claude subagents that extract entry-level signals).
  merge:         merge per-batch signal output JSONs into a single
                 signals.jsonl that ingest_enriched.py consumes.

Per `docs/plans/2026-05-11-r5-track3-richer-ingest.md` Task 2.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def cmd_build_batches(args: argparse.Namespace) -> None:
    data = json.loads(args.data.read_text())
    sessions: dict[str, dict] = {}
    for entry in data:
        for sid, dt, turns in zip(
            entry['haystack_session_ids'],
            entry['haystack_dates'],
            entry['haystack_sessions'],
        ):
            if sid in sessions:
                continue
            content_chunks = [f"[{t['role']}] {t['content']}" for t in turns]
            full_text = '\n'.join(content_chunks)
            # Truncate to bound per-subagent prompt size at the prereg's
            # 35-40KB upper estimate (50 sessions × max_chars + rubric ≈ that).
            truncated = full_text[: args.max_chars]
            sessions[sid] = {
                'session_id': sid,
                'date': dt,
                'text': truncated,
                'truncated': len(full_text) > args.max_chars,
            }
    sids = sorted(sessions.keys())
    args.out_dir.mkdir(parents=True, exist_ok=True)
    n = 0
    total_bytes = 0
    for i in range(0, len(sids), args.batch_size):
        batch = [sessions[s] for s in sids[i:i + args.batch_size]]
        out = args.out_dir / f"batch_{n:03d}.json"
        body = json.dumps(batch, indent=2)
        out.write_text(body)
        total_bytes += len(body)
        n += 1
    print(
        f"Wrote {n} batches ({len(sids)} sessions, max_chars={args.max_chars}, "
        f"avg batch size {total_bytes // max(n, 1)} bytes) to {args.out_dir}",
        file=sys.stderr,
    )


def cmd_merge(args: argparse.Namespace) -> None:
    out_lines: list[str] = []
    for f in sorted(args.in_dir.glob('batch_*.signals.json')):
        items = json.loads(f.read_text())
        for it in items:
            out_lines.append(json.dumps(it))
    args.out.write_text('\n'.join(out_lines) + ('\n' if out_lines else ''))
    print(f"Wrote {len(out_lines)} signal entries to {args.out}", file=sys.stderr)


def main() -> None:
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest='cmd', required=True)

    s1 = sub.add_parser('build-batches', help='split sessions into per-subagent input JSONs')
    s1.add_argument('--data', type=Path, required=True, help='LongMemEval oracle JSON path')
    s1.add_argument('--out-dir', type=Path, required=True, help='destination dir for batch_NNN.json')
    s1.add_argument('--batch-size', type=int, default=50)
    s1.add_argument('--max-chars', dest='max_chars', type=int, default=600,
                    help='truncate per-session text to this many chars (matches F10 prereg per-subagent budget)')
    s1.set_defaults(func=cmd_build_batches)

    s2 = sub.add_parser('merge', help='concatenate per-batch signal outputs into signals.jsonl')
    s2.add_argument('--in-dir', type=Path, required=True, help='dir containing batch_NNN.signals.json files')
    s2.add_argument('--out', type=Path, required=True, help='output signals.jsonl path')
    s2.set_defaults(func=cmd_merge)

    args = p.parse_args()
    args.func(args)


if __name__ == '__main__':
    main()
