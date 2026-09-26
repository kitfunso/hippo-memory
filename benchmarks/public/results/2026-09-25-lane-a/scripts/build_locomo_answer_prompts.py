import json, io, os, sys

BENCH = r'C:\Users\skf_s\hippo-bench\memory-benchmarks'
sys.path.insert(0, BENCH)
from benchmarks.locomo.prompts import get_answer_generation_prompt

LANE_A = r'C:\Users\skf_s\hippo\benchmarks\public\results\2026-09-25-lane-a'
PREDICTED = r'C:\Users\skf_s\hippo\benchmarks\public\results\2026-09-25-lane-r\predicted\predicted_locomo-hippo365'

sample = json.load(io.open(os.path.join(LANE_A, 'locomo', 'sample.json'), encoding='utf-8'))
assert len(sample) == 400, len(sample)

BATCH_SIZE = 40
meta = {}  # qid -> {category_name, ground_truth_answer, reference_date}
for i, qid in enumerate(sample):
    batch = i // BATCH_SIZE
    q = json.load(io.open(os.path.join(PREDICTED, qid + '.json'), encoding='utf-8'))
    top10 = q['retrieval']['search_results'][:10]
    prompt = get_answer_generation_prompt(q['question'], top10, reference_date=q['reference_date'])
    d = os.path.join(LANE_A, 'locomo', 'answer_prompts', 'hippo365', f'batch-{batch}')
    os.makedirs(d, exist_ok=True)
    io.open(os.path.join(d, qid + '.txt'), 'w', encoding='utf-8').write(prompt)
    meta[qid] = {
        'category': q['category'],
        'category_name': q['category_name'],
        'ground_truth_answer': q['ground_truth_answer'],
    }

json.dump(meta, io.open(os.path.join(LANE_A, 'locomo', 'gold_meta.json'), 'w', encoding='utf-8'))
n_batches = (len(sample) + BATCH_SIZE - 1) // BATCH_SIZE
print('wrote', len(sample), 'prompts in', n_batches, 'batches')
