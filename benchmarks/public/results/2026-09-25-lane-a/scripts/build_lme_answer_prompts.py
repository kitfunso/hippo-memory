import json, io, os, sys

BENCH = r'C:\Users\skf_s\hippo-bench\memory-benchmarks'
sys.path.insert(0, BENCH)
from benchmarks.longmemeval.prompts import get_answer_generation_prompt

LANE_A = r'C:\Users\skf_s\hippo\benchmarks\public\results\2026-09-25-lane-a'
PRED = {
    'hippo365': r'C:\Users\skf_s\hippo\benchmarks\public\results\2026-09-25-lane-r\predicted\predicted_lme-hippo365',
    'bm25': r'C:\Users\skf_s\hippo\benchmarks\public\results\2026-09-25-lane-r\predicted\predicted_lme-bm25',
}

qids = sorted(io.open(os.path.join(LANE_A, 'lme', 'qids_hippo365.txt'), encoding='utf-8').read().split())
assert len(qids) == 500, len(qids)
json.dump(qids, io.open(os.path.join(LANE_A, 'lme', 'sample.json'), 'w', encoding='utf-8'))

BATCH_SIZE = 40
meta = {}
for arm, pred_dir in PRED.items():
    for i, qid in enumerate(qids):
        batch = i // BATCH_SIZE
        q = json.load(io.open(os.path.join(pred_dir, qid + '.json'), encoding='utf-8'))
        top10 = q['retrieval']['search_results'][:10]
        prompt = get_answer_generation_prompt(q['question'], top10, question_date=q['question_date'])
        d = os.path.join(LANE_A, 'lme', 'answer_prompts', arm, f'batch-{batch}')
        os.makedirs(d, exist_ok=True)
        io.open(os.path.join(d, qid + '.txt'), 'w', encoding='utf-8').write(prompt)
        if arm == 'hippo365':
            meta[qid] = {
                'question_type': q['question_type'],
                'ground_truth_answer': q['ground_truth_answer'],
                'is_abstention': q['is_abstention'],
                'question_date': q['question_date'],
            }

json.dump(meta, io.open(os.path.join(LANE_A, 'lme', 'gold_meta.json'), 'w', encoding='utf-8'))
n_batches = (len(qids) + BATCH_SIZE - 1) // BATCH_SIZE
print('wrote', len(qids), 'prompts per arm in', n_batches, 'batches, for', len(PRED), 'arms')
