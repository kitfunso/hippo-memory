"""Project round 4's list-price spend (USD) from round 3's recorded spend: the budget, the ceiling, batch 1, the pilot, the q145 gap and the whole-run check.
Usage: python -I docs/evals/z0-r4/r4-projection.py ROOT [--manifest FILE]
Stops unless ROOT's runs files match the manifest."""
import argparse
import pathlib
import sys

sys.path.append(str(pathlib.Path(__file__).resolve().parent))
import r3_manifest  # noqa: E402
import r3_spend  # noqa: E402

ARMS = ('A0', 'A1', 'A2', 'A4', 'A5')
# Prereg item 12's batch 1: the draw of 10 repositories.
BATCH1 = ('q12', 'q14', 'q140', 'q145', 'q184', 'q190', 'q212', 'q222', 'q226', 'q238')
PILOT_BUDGET = 40.0
# Item 11: 2 repositories x 18 positions (round 3 prereg line 40) x 1 seed; O1 is one arm, S1 and S2 are two.
PER_ARM_SESSIONS = 2 * 18 * 1
# The ceiling runs O1, S1, S2 and S5 at 9 seeds against 3.
CEILING = {'O1': 9 / 3, 'A1': 9 / 3, 'A2': 9 / 3, 'A5': 9 / 3}


def project(basis, r, pilot=0.0, scale=None):
    """O1 at A1's basis plus 0.5 x r x every arm's basis, plus the pilot; scale multiplies the named terms."""
    scale = scale or {}
    o1 = basis['A1'] * scale.get('O1', 1)
    return pilot + o1 + sum(0.5 * r * basis[a] * scale.get(a, 1) for a in ARMS)


def show(label, value):
    print(f'{label}: {value:.2f}')


ap = argparse.ArgumentParser()
r3_manifest.add_flags(ap)
args = ap.parse_args()

rows, seen = r3_spend.load(r3_manifest.checked_files(args.root, args.manifest))
if not set(BATCH1) <= seen:
    sys.exit(f'no records for sequences {sorted(set(BATCH1) - seen)}')
basis = r3_spend.totals(rows)[0]
batch = r3_spend.totals(rows, set(BATCH1))[0]
by_sequence = {q: r3_spend.totals(rows, {q})[0] for q in BATCH1}

show('basis, O1 (A1)', basis['A1'])
show('basis, S1 + S2 + S5 (A1, A2, A5)', basis['A1'] + basis['A2'] + basis['A5'])
show('basis, S0 + S4 (A0, A4)', basis['A0'] + basis['A4'])
for r in (1, 1.5, 2):
    show(f'projection at r={r}, with the pilot', project(basis, r, PILOT_BUDGET))
show('ceiling at r=2, with the pilot', project(basis, 2, PILOT_BUDGET, CEILING))
for r in (1, 2):
    show(f'batch 1 at r={r}, no pilot', project(batch, r))

costs = [cost for _kind, _sequence, _arm, tool, cost in rows if tool == 'claude-code']
mean = sum(costs) / len(costs)
print(f'pilot sessions: {3 * PER_ARM_SESSIONS} (O1 {PER_ARM_SESSIONS}, S1 and S2 {2 * PER_ARM_SESSIONS})')
show(f'mean costUsd per Claude Code record over {len(costs)} records', mean)
for r in (1, 2):
    show(f'pilot estimate at r={r}', mean * (PER_ARM_SESSIONS + 0.5 * r * 2 * PER_ARM_SESSIONS))

others = [q for q in BATCH1 if q != 'q145']
gap = {a: sum(by_sequence[q][a] for q in others) / len(others) - by_sequence['q145'][a] for a in ARMS}
for a in ARMS:
    show(f'q145 gap, {a}', gap[a])
for r in (1, 2):
    show(f'q145 gap projected at r={r}, no pilot', project(gap, r))
for q in ('q145', 'q140'):
    show(f'{q} total', sum(by_sequence[q].values()))

# Item 12's whole-run check before batch 1, at the approved figure of decision 5.
APPROVED = 2140.0
MARGIN = 1.25


def whole_run(r, seeds):
    """Spend after the pilot: the whole run at r with q145's gap, O1, S1, S2 and S5 at `seeds` seeds."""
    s = {k: seeds / 3 for k in CEILING}
    return project(basis, r, 0.0, s) + project(gap, r, 0.0, s)


for seeds in (3, 4, 5, 6):
    fits = [i / 100 for i in range(50, 301) if PILOT_BUDGET + MARGIN * whole_run(i / 100, seeds) <= APPROVED]
    print(f'whole-run check at {APPROVED:.2f}, {seeds} seeds: fits up to r={max(fits) if fits else "none from 0.5"}')
for r in (1, 2):
    need = [f'{PILOT_BUDGET + MARGIN * whole_run(r, n):.2f}' for n in (3, 5)]
    print(f'figure the whole-run check needs at r={r}, 3 and 5 seeds: {need[0]}, {need[1]}')
