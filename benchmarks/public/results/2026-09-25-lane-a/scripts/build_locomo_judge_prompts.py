import json, io, os, sys, random, glob

BENCH = r'C:\Users\skf_s\hippo-bench\memory-benchmarks'
sys.path.insert(0, BENCH)
from benchmarks.locomo.prompts import get_judge_prompt, preprocess_answer, JUDGE_SYSTEM_PROMPT

LANE_A = r'C:\Users\skf_s\hippo\benchmarks\public\results\2026-09-25-lane-a'
LOCOMO = os.path.join(LANE_A, 'locomo')
PREDICTED = r'C:\Users\skf_s\hippo\benchmarks\public\results\2026-09-25-lane-r\predicted\predicted_locomo-hippo365'

gold_meta = json.load(io.open(os.path.join(LOCOMO, 'gold_meta.json'), encoding='utf-8'))
# gold_meta lacks question text (only category/gold answer) -- pull it from the Lane R predicted files
question_text = {}
for qid in gold_meta:
    q = json.load(io.open(os.path.join(PREDICTED, qid + '.json'), encoding='utf-8'))
    question_text[qid] = q['question']

items = []  # {'arm','qid','answer','prompt'}

# new hippo365 answers (400)
for f in sorted(glob.glob(os.path.join(LOCOMO, 'answers', 'hippo365-batch-*.jsonl'))):
    for line in io.open(f, encoding='utf-8'):
        line = line.strip()
        if not line:
            continue
        a = json.loads(line)
        q = gold_meta[a['id']]
        gold = preprocess_answer(q['category'], str(q['ground_truth_answer']))
        items.append({
            'arm': 'hippo365', 'qid': a['id'], 'answer': a['answer'],
            'prompt': JUDGE_SYSTEM_PROMPT + '\n\n' + get_judge_prompt(q['category'], question_text[a['id']], gold, a['answer']),
        })

# reused bm25 answers from Amendment 1 (400), RE-JUDGED fresh in this blind shuffle
amendment1 = [json.loads(l) for l in io.open(os.path.join(LOCOMO, 'reused-from-amendment1', 'amendment1-answers.jsonl'), encoding='utf-8') if l.strip()]
bm25_answers = [a for a in amendment1 if a['arm'] == 'bm25']
assert len(bm25_answers) == 400, len(bm25_answers)
for a in bm25_answers:
    q = gold_meta[a['id']]
    gold = preprocess_answer(q['category'], str(q['ground_truth_answer']))
    items.append({
        'arm': 'bm25', 'qid': a['id'], 'answer': a['answer'],
        'prompt': JUDGE_SYSTEM_PROMPT + '\n\n' + get_judge_prompt(q['category'], question_text[a['id']], gold, a['answer']),
    })

assert len(items) == 800, len(items)

random.seed(7)
random.shuffle(items)

judge_dir = os.path.join(LOCOMO, 'judge_prompts')
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

json.dump(key, io.open(os.path.join(LOCOMO, 'judge_key.json'), 'w', encoding='utf-8'))
n_batches = (len(items) + BATCH_SIZE - 1) // BATCH_SIZE
print(len(items), 'judge items in', n_batches, 'batches')
