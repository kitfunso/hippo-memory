import json, glob, os, random, io

LANE_A = r'C:\Users\skf_s\hippo\benchmarks\public\results\2026-09-25-lane-a'
LME = os.path.join(LANE_A, 'lme')

gold_meta = json.load(io.open(os.path.join(LME, 'gold_meta.json'), encoding='utf-8'))
sample = json.load(io.open(os.path.join(LME, 'sample.json'), encoding='utf-8'))

key = json.load(io.open(os.path.join(LME, 'judge_key.json'), encoding='utf-8'))
verd = {}  # judge id -> bool correct
for f in glob.glob(os.path.join(LME, 'verdicts', '*.jsonl')):
    for l in io.open(f, encoding='utf-8'):
        if l.strip():
            v = json.loads(l)
            verd[v['id']] = str(v['verdict']).strip().lower() == 'yes'

judge = {(k['arm'], k['qid']): verd[j] for j, k in key.items() if j in verd}

rows = []
for q in sample:
    meta = gold_meta[q]
    rows.append({
        'qid': q,
        'qtype': meta['question_type'],
        'j_h': judge.get(('hippo365', q)),
        'j_b': judge.get(('bm25', q)),
    })

def boot(d):
    random.seed(1)
    n = len(d)
    m = sorted(sum(random.choice(d) for _ in range(n)) / n for _ in range(4000))
    return sum(d) / n, m[100], m[3899]

def report(label, subset):
    r = [x for x in subset if x['j_h'] is not None and x['j_b'] is not None]
    if not r:
        print(f'{label:<28} n=0 (no paired data)')
        return
    h = sum(x['j_h'] for x in r) / len(r)
    b = sum(x['j_b'] for x in r) / len(r)
    d, lo, hi = boot([float(x['j_h']) - float(x['j_b']) for x in r])
    print(f'{label:<28} n={len(r):<4} hippo365 {100*h:5.1f}  bm25 {100*b:5.1f}  diff {100*d:+.1f} [{100*lo:+.1f}, {100*hi:+.1f}]')

print('=== LongMemEval-S: hippo@365 vs bm25 ===')
report('Judge accuracy, all', rows)
QTYPES = ['knowledge-update', 'temporal-reasoning', 'multi-session',
          'single-session-user', 'single-session-assistant', 'single-session-preference']
for qt in QTYPES:
    sub = [x for x in rows if x['qtype'] == qt]
    report(f'  {qt}', sub)

print('judge verdicts available (hippo365):', sum(1 for x in rows if x['j_h'] is not None), 'of 500')
print('judge verdicts available (bm25):', sum(1 for x in rows if x['j_b'] is not None), 'of 500')
