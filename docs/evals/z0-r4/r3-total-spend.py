"""Sum round 3's list-price spend over every record of every run attempt, kept or not, by arm and folder kind.
Usage: python -I docs/evals/z0-r4/r3-total-spend.py ROOT [--sequences q12,q14,...] [--manifest FILE] [--write-manifest]
Stops unless ROOT's runs files match the manifest; --write-manifest writes it, once, when a round's folder is frozen."""
import argparse
import pathlib
import sys

sys.path.append(str(pathlib.Path(__file__).resolve().parent))
import r3_manifest  # noqa: E402
import r3_spend  # noqa: E402

ap = argparse.ArgumentParser()
r3_manifest.add_flags(ap)
ap.add_argument('--sequences')
ap.add_argument('--write-manifest', action='store_true')
args = ap.parse_args()

if args.write_manifest:
    r3_manifest.write(args.root, args.manifest)
    sys.exit(0)

only = None if args.sequences is None else set(args.sequences.split(','))
files = r3_manifest.checked_files(args.root, args.manifest)
rows, seen = r3_spend.load(files)
by_arm, n_arm, by_kind = r3_spend.totals(rows, only)
if only is not None and not only <= seen:
    sys.exit(f'no records for sequences {sorted(only - seen)}')
print('files', len(files), 'sequences', 'all' if only is None else ','.join(sorted(only)))
for arm in sorted(by_arm):
    print(f'{arm} records {n_arm[arm]} costUsd {by_arm[arm]:.2f}')
for k in sorted(by_kind):
    print(f'{k} costUsd {by_kind[k]:.2f}')
print(f'total {sum(by_arm.values()):.2f}')
