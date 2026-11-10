"""Sum round 3's list-price spend over every record of every run attempt, kept or not, by arm and folder kind.
Usage: python -I docs/evals/z0-r4/r3-total-spend.py C:/z0-runs/scored/r3run [--sequences q12,q14,...]"""
import collections
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
only = None
if '--sequences' in sys.argv:
    only = set(sys.argv[sys.argv.index('--sequences') + 1].split(','))
files = sorted(root.glob('*/run/runs.jsonl'))
by_arm = collections.Counter()
by_kind = collections.Counter()
n_arm = collections.Counter()
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
            if only is not None and r.get('sequence') not in only:
                continue
            cost = r.get('costUsd')
            if not isinstance(cost, (int, float)):
                continue
            by_arm[r.get('arm')] += cost
            n_arm[r.get('arm')] += 1
            by_kind[kind] += cost
if only is not None and not only <= seen:
    sys.exit(f'no records for sequences {sorted(only - seen)}')
print('files', len(files), 'sequences', 'all' if only is None else ','.join(sorted(only)))
for arm in sorted(by_arm):
    print(f'{arm} records {n_arm[arm]} costUsd {by_arm[arm]:.2f}')
for k in sorted(by_kind):
    print(f'{k} costUsd {by_kind[k]:.2f}')
print(f'total {sum(by_arm.values()):.2f}')
