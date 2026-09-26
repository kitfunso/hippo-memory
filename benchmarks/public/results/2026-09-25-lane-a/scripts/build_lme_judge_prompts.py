import json, io, os, sys, random, glob

BENCH = r'C:\Users\skf_s\hippo-bench\memory-benchmarks'
sys.path.insert(0, BENCH)
from benchmarks.longmemeval.prompts import get_judge_prompt

LANE_A = r'C:\Users\skf_s\hippo\benchmarks\public\results\2026-09-25-lane-a'
LME = os.path.join(LANE_A, 'lme')
PRED = {
    'hippo365': r'C:\Users\skf_s\hippo\benchmarks\public\results\2026-09-25-lane-r\predicted\predicted_lme-hippo365',
    'bm25': r'C:\Users\skf_s\hippo\benchmarks\public\results\2026-09-25-lane-r\predicted\predicted_lme-bm25',
}

gold_meta = json.load(io.open(os.path.join(LME, 'gold_meta.json'), encoding='utf-8'))
# gold_meta lacks question text -- pull it from the Lane R predicted files (hippo365 side; same qid set both arms)
question_text = {}
for qid in gold_meta:
    q = json.load(io.open(os.path.join(PRED['hippo365'], qid + '.json'), encoding='utf-8'))
    question_text[qid] = q['question']

items = []  # {'arm','qid','answer','prompt'}
for arm in ('hippo365', 'bm25'):
    files = sorted(glob.glob(os.path.join(LME, 'answers', f'{arm}-batch-*.jsonl')))
    for f in files:
        for line in io.open(f, encoding='utf-8'):
            line = line.strip()
            if not line:
                continue
            a = json.loads(line)
            meta = gold_meta[a['id']]
            prompt = get_judge_prompt(
                question_type=meta['question_type'],
                question_id=a['id'],
                question=question_text[a['id']],
                answer=meta['ground_truth_answer'],
                response=a['answer'],
                question_date=meta['question_date'],
            )
            items.append({'arm': arm, 'qid': a['id'], 'answer': a['answer'], 'prompt': prompt})

assert len(items) == 1000, len(items)

random.seed(7)
random.shuffle(items)

judge_dir = os.path.join(LME, 'judge_prompts')
os.makedirs(judge_dir, exist_ok=True)
key = {}
BATCH_SIZE = 80
for i, it in enumerate(items):
    jid = f'j{i:04d}'
    key[jid] = {'arm': it['arm'], 'qid': it['qid'], 'answer': it['answer']}
    b = i // BATCH_SIZE
    d = os.path.join(judge_dir, f'batch-{b}')
    os.makedirs(d, exist_ok=True)
    io.open(os.path.join(d, jid + '.txt'), 'w', encoding='utf-8').write(it['prompt'])

json.dump(key, io.open(os.path.join(LME, 'judge_key.json'), 'w', encoding='utf-8'))
n_batches = (len(items) + BATCH_SIZE - 1) // BATCH_SIZE
print(len(items), 'judge items in', n_batches, 'batches')
