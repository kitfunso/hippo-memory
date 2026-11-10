"""Round 3's costUsd by arm, sequence and folder kind over a set of runs files; stdlib only, imported by path."""
import collections
import json


def load(files):
    """Every record with a numeric costUsd as (kind, sequence, arm, tool, cost), and every sequence any record names."""
    rows = []
    seen = set()
    for f in files:
        run = f.parent.parent.name
        kind = 'kept' if run.split('.')[0] == run else 'aborted'
        if run == 'gr3-w1':
            kind = 'set-aside'
        with f.open(encoding='utf-8') as fh:
            for line in fh:
                if not line.strip():
                    continue
                r = json.loads(line)
                seen.add(r.get('sequence'))
                cost = r.get('costUsd')
                if isinstance(cost, (int, float)):
                    rows.append((kind, r.get('sequence'), r.get('arm'), r.get('tool'), cost))
    return rows, seen


def totals(rows, only=None):
    """Cost by arm, record count by arm and cost by folder kind, over the sequences in only (all when None)."""
    by_arm = collections.Counter()
    n_arm = collections.Counter()
    by_kind = collections.Counter()
    for kind, sequence, arm, _tool, cost in rows:
        if only is not None and sequence not in only:
            continue
        by_arm[arm] += cost
        n_arm[arm] += 1
        by_kind[kind] += cost
    return by_arm, n_arm, by_kind
