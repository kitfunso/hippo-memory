import json, glob, os, random, sys, types, io, contextlib

sys.modules['bert_score'] = types.SimpleNamespace(score=None)
sys.path.insert(0, r'C:\Users\skf_s\hippo-bench\locomo\task_eval')
import evaluation as ev

LANE_A = r'C:\Users\skf_s\hippo\benchmarks\public\results\2026-09-25-lane-a'
LOCOMO = os.path.join(LANE_A, 'locomo')
# --rerun: deviation 3, bm25 answers regenerated with the identical procedure and judged blind with hippo@365.
RERUN = '--rerun' in sys.argv
JUDGED = os.path.join(LOCOMO, 'bm25-rerun') if RERUN else LOCOMO

data = json.load(io.open(r'C:\Users\skf_s\hippo-bench\locomo\data\locomo10.json', encoding='utf-8'))

# answers: (arm, qid) -> text. arms: hippo365 (new), bm25 (reused amendment1), hippo7 (amendment1, secondary compare)
ans = {}
for f in glob.glob(os.path.join(LOCOMO, 'answers', 'hippo365-batch-*.jsonl')):
    for l in io.open(f, encoding='utf-8'):
        if l.strip():
            a = json.loads(l); ans[('hippo365', a['id'])] = a['answer']
amendment1 = [json.loads(l) for l in io.open(os.path.join(LOCOMO, 'reused-from-amendment1', 'amendment1-answers.jsonl'), encoding='utf-8') if l.strip()]
for a in amendment1:
    arm = 'hippo7' if a['arm'] == 'hippo' else a['arm']  # amendment1 called the 7-day arm 'hippo'
    ans[(arm, a['id'])] = a['answer']
if RERUN:
    for f in glob.glob(os.path.join(JUDGED, 'answers', 'bm25-batch-*.jsonl')):
        for l in io.open(f, encoding='utf-8'):
            if l.strip():
                a = json.loads(l); ans[('bm25', a['id'])] = a['answer']

# judge_key: jid -> {arm, qid, answer}; verdicts: jid -> label CORRECT/WRONG (new blind judging, hippo365 + bm25 re-judged)
key = json.load(io.open(os.path.join(JUDGED, 'judge_key.json'), encoding='utf-8'))
verd = {}
for f in glob.glob(os.path.join(JUDGED, 'verdicts', '*.jsonl')):
    for l in io.open(f, encoding='utf-8'):
        if l.strip():
            v = json.loads(l); verd[v['id']] = v['label'].upper() == 'CORRECT'
judge_new = {(k['arm'], k['qid']): verd[j] for j, k in key.items() if j in verd}

# old bm25 verdicts from amendment1 (for the "report both old and new bm25" requirement)
# amendment1's verdicts.jsonl embeds arm + id (qid) directly per line, no separate judge_key needed.
old_bm25_judge = {}
for l in io.open(os.path.join(LOCOMO, 'reused-from-amendment1', 'amendment1-verdicts.jsonl'), encoding='utf-8'):
    if l.strip():
        v = json.loads(l)
        if v['arm'] == 'bm25':
            old_bm25_judge[v['id']] = v['label'].upper() == 'CORRECT'

sample = json.load(io.open(os.path.join(LOCOMO, 'sample.json'), encoding='utf-8'))
CAT = {1: 'multi-hop', 2: 'temporal', 3: 'open-domain', 4: 'single-hop'}

def f1(arm, qid):
    conv, qi = qid.split('_q')
    qa = data[int(conv[4:])]['qa'][int(qi)]
    score = ev.eval_question_answering(
        [{'answer': qa['answer'], 'category': qa['category'], 'prediction': ans[(arm, qid)], 'evidence': []}],
        'prediction',
    )[0][0]
    return score, qa['category']

rows = []
with contextlib.redirect_stdout(io.StringIO()):
    for q in sample:
        fh, cat = f1('hippo365', q)
        fb, _ = f1('bm25', q)
        f7, _ = f1('hippo7', q) if ('hippo7', q) in ans else (None, cat)
        rows.append({
            'qid': q, 'cat': cat,
            'f1_h': fh, 'f1_b': fb, 'f1_h7': f7,
            'j_h': judge_new.get(('hippo365', q)),
            'j_b_new': judge_new.get(('bm25', q)),
            'j_b_old': old_bm25_judge.get(q),
        })

def boot(d):
    random.seed(1)
    n = len(d)
    m = sorted(sum(random.choice(d) for _ in range(n)) / n for _ in range(4000))
    return sum(d) / n, m[100], m[3899]

def report(label, key_a, key_b, subset):
    r = [x for x in subset if x[key_a] is not None and x[key_b] is not None]
    if not r:
        print(f'{label:<32} n=0 (no paired data)')
        return
    a = sum(x[key_a] for x in r) / len(r)
    b = sum(x[key_b] for x in r) / len(r)
    d, lo, hi = boot([float(x[key_a]) - float(x[key_b]) for x in r])
    print(f'{label:<32} n={len(r):<4} A {100*a:5.1f}  B {100*b:5.1f}  diff {100*d:+.1f} [{100*lo:+.1f}, {100*hi:+.1f}]')

print('=== LoCoMo: hippo@365 vs bm25 (re-judged) ===')
report("Authors' F1, all", 'f1_h', 'f1_b', rows)
report('Judge accuracy, all', 'j_h', 'j_b_new', rows)
for c in (4, 1, 2, 3):
    sub = [x for x in rows if x['cat'] == c]
    report(f"  F1 {CAT[c]}", 'f1_h', 'f1_b', sub)
    report(f"  judge {CAT[c]}", 'j_h', 'j_b_new', sub)

print()
print('=== LoCoMo: hippo@365 vs Amendment 1 hippo@7 (secondary) ===')
report("Authors' F1, all", 'f1_h', 'f1_h7', rows)

print()
print('=== bm25 judge accuracy: old (Amendment 1 verdicts) vs new (this blind re-judge) ===')
report('bm25 old vs new', 'j_b_old', 'j_b_new', rows)
n_old = sum(1 for x in rows if x['j_b_old'] is not None)
n_new = sum(1 for x in rows if x['j_b_new'] is not None)
print(f'old bm25 verdicts available: {n_old}/400   new bm25 verdicts available: {n_new}/400')
print('judge verdicts available (hippo365):', sum(1 for x in rows if x['j_h'] is not None), 'of 400')
