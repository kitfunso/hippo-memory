"""Price round 3 records that have usage but no costUsd, at the Opus 5.5 rows of prices.json.
Usage: python -I docs/evals/z0-r4/r3-null-cost.py ROOT [--manifest FILE]
Stops unless ROOT's runs files match the manifest."""
import argparse
import collections
import json
import pathlib
import sys

sys.path.append(str(pathlib.Path(__file__).resolve().parent))
import r3_manifest  # noqa: E402

P = {'inputTokens': 4, 'outputTokens': 20, 'cacheCreationInputTokens': 8, 'cacheReadInputTokens': 0.2}
ap = argparse.ArgumentParser()
r3_manifest.add_flags(ap)
args = ap.parse_args()

key_seen = None
with_usage = collections.Counter()
usd = collections.Counter()
no_usage = 0
reasons = collections.Counter()


def price(u):
    global key_seen
    if not u:
        return 0.0
    key_seen = key_seen or sorted(u)
    return sum(u.get(k, 0) * v for k, v in P.items()) / 1e6


for f in r3_manifest.checked_files(args.root, args.manifest):
    for line in f.open(encoding='utf-8'):
        if not line.strip():
            continue
        r = json.loads(line)
        if isinstance(r.get('costUsd'), (int, float)):
            continue
        u = r.get('usage')
        if not u:
            no_usage += 1
            reasons[str(r.get('invalid'))[:60]] += 1
            continue
        c = price(u.get('firstSession')) + price(u.get('extra'))
        with_usage[r['arm']] += 1
        usd[r['arm']] += c
print('usage keys', key_seen)
print('null cost with usage', dict(with_usage), {a: round(v, 2) for a, v in usd.items()}, 'total', round(sum(usd.values()), 2))
print('null cost, no usage', no_usage, reasons.most_common(4))
