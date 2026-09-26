"""Blind judge prompts for deviation 3: hippo@365 answers shuffled with the regenerated bm25 answers."""
import glob, io, json, os, random, sys

BENCH = r'C:\Users\skf_s\hippo-bench\memory-benchmarks'
sys.path.insert(0, BENCH)
from benchmarks.locomo.prompts import get_judge_prompt, preprocess_answer, JUDGE_SYSTEM_PROMPT

LOCOMO = r'C:\Users\skf_s\hippo\benchmarks\public\results\2026-09-25-lane-a\locomo'
RERUN = os.path.join(LOCOMO, 'bm25-rerun')
PREDICTED = r'C:\Users\skf_s\hippo\benchmarks\public\results\2026-09-25-lane-r\predicted\predicted_locomo-hippo365'

gold_meta = json.load(io.open(os.path.join(LOCOMO, 'gold_meta.json'), encoding='utf-8'))
question_text = {qid: json.load(io.open(os.path.join(PREDICTED, qid + '.json'), encoding='utf-8'))['question']
                 for qid in gold_meta}


def load(pattern: str, arm: str) -> list[dict]:
    out = []
    for f in sorted(glob.glob(pattern)):
        for line in io.open(f, encoding='utf-8'):
            if line.strip():
                a = json.loads(line)
                q = gold_meta[a['id']]
                gold = preprocess_answer(q['category'], str(q['ground_truth_answer']))
                out.append({'arm': arm, 'qid': a['id'], 'answer': a['answer'],
                            'prompt': JUDGE_SYSTEM_PROMPT + '\n\n' + get_judge_prompt(
                                q['category'], question_text[a['id']], gold, a['answer'])})
    return out


hippo = load(os.path.join(LOCOMO, 'answers', 'hippo365-batch-*.jsonl'), 'hippo365')
bm25 = load(os.path.join(RERUN, 'answers', 'bm25-batch-*.jsonl'), 'bm25')
assert len(hippo) == 400 and len(bm25) == 400, (len(hippo), len(bm25))
assert {i['qid'] for i in hippo} == {i['qid'] for i in bm25}
items = hippo + bm25
random.seed(7)
random.shuffle(items)

key = {}
for i, it in enumerate(items):
    jid = f'j{i:04d}'
    key[jid] = {'arm': it['arm'], 'qid': it['qid'], 'answer': it['answer']}
    d = os.path.join(RERUN, 'judge_prompts', f'batch-{i // 80}')
    os.makedirs(d, exist_ok=True)
    io.open(os.path.join(d, jid + '.txt'), 'w', encoding='utf-8').write(it['prompt'])
json.dump(key, io.open(os.path.join(RERUN, 'judge_key.json'), 'w', encoding='utf-8'))
print(len(items), 'judge items in', (len(items) + 79) // 80, 'batches')
