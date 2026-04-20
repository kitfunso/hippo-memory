# Parameter sweep results

Corpus: `real-corpus.json` (15 cases, local + global in scope)
Sweep space: 30 combinations across lambda x emb-weight x local-bump x mmr-toggle

## Top 15 by NDCG@10

| Rank | Config | MRR | R@5 | R@10 | NDCG@10 |
|---|---|---|---|---|---|
| 1 | lambda=0.5 emb=0.4 bump=1.2 | 1.000 | 66.2% | 67.1% | 0.745 |
| 2 | lambda=0.7 emb=0.4 bump=1.2 | 1.000 | 66.2% | 67.1% | 0.745 |
| 3 | lambda=0.9 emb=0.4 bump=1.2 | 1.000 | 66.2% | 67.1% | 0.745 |
| 4 | lambda=1 emb=0.4 bump=1.2 | 1.000 | 66.2% | 67.1% | 0.745 |
| 5 | no-MMR emb=0.4 bump=1.2 | 1.000 | 66.2% | 67.1% | 0.745 |
| 6 | lambda=0.5 emb=0.6 bump=1 | 0.967 | 67.1% | 67.1% | 0.726 |
| 7 | lambda=0.5 emb=0.8 bump=1 | 0.967 | 67.1% | 67.1% | 0.726 |
| 8 | lambda=0.5 emb=0.8 bump=1.2 | 0.967 | 67.1% | 67.1% | 0.726 |
| 9 | lambda=0.7 emb=0.6 bump=1 | 0.967 | 67.1% | 67.1% | 0.726 |
| 10 | lambda=0.7 emb=0.8 bump=1 | 0.967 | 67.1% | 67.1% | 0.726 |
| 11 | lambda=0.7 emb=0.8 bump=1.2 | 0.967 | 67.1% | 67.1% | 0.726 |
| 12 | lambda=0.9 emb=0.6 bump=1 | 0.967 | 67.1% | 67.1% | 0.726 |
| 13 | lambda=0.9 emb=0.8 bump=1 | 0.967 | 67.1% | 67.1% | 0.726 |
| 14 | lambda=0.9 emb=0.8 bump=1.2 | 0.967 | 67.1% | 67.1% | 0.726 |
| 15 | lambda=1 emb=0.6 bump=1 | 0.967 | 67.1% | 67.1% | 0.726 |

## Pareto frontier (20 configs)

These are non-dominated across all four metrics. Any improvement on one metric costs something on another.

| Config | MRR | R@5 | R@10 | NDCG@10 |
|---|---|---|---|---|
| lambda=0.5 emb=0.4 bump=1.2 | 1.000 | 66.2% | 67.1% | 0.745 |
| lambda=0.7 emb=0.4 bump=1.2 | 1.000 | 66.2% | 67.1% | 0.745 |
| lambda=0.9 emb=0.4 bump=1.2 | 1.000 | 66.2% | 67.1% | 0.745 |
| lambda=1 emb=0.4 bump=1.2 | 1.000 | 66.2% | 67.1% | 0.745 |
| no-MMR emb=0.4 bump=1.2 | 1.000 | 66.2% | 67.1% | 0.745 |
| lambda=0.5 emb=0.6 bump=1 | 0.967 | 67.1% | 67.1% | 0.726 |
| lambda=0.5 emb=0.8 bump=1 | 0.967 | 67.1% | 67.1% | 0.726 |
| lambda=0.5 emb=0.8 bump=1.2 | 0.967 | 67.1% | 67.1% | 0.726 |
| lambda=0.7 emb=0.6 bump=1 | 0.967 | 67.1% | 67.1% | 0.726 |
| lambda=0.7 emb=0.8 bump=1 | 0.967 | 67.1% | 67.1% | 0.726 |
| lambda=0.7 emb=0.8 bump=1.2 | 0.967 | 67.1% | 67.1% | 0.726 |
| lambda=0.9 emb=0.6 bump=1 | 0.967 | 67.1% | 67.1% | 0.726 |
| lambda=0.9 emb=0.8 bump=1 | 0.967 | 67.1% | 67.1% | 0.726 |
| lambda=0.9 emb=0.8 bump=1.2 | 0.967 | 67.1% | 67.1% | 0.726 |
| lambda=1 emb=0.6 bump=1 | 0.967 | 67.1% | 67.1% | 0.726 |
| lambda=1 emb=0.8 bump=1 | 0.967 | 67.1% | 67.1% | 0.726 |
| lambda=1 emb=0.8 bump=1.2 | 0.967 | 67.1% | 67.1% | 0.726 |
| no-MMR emb=0.6 bump=1 | 0.967 | 67.1% | 67.1% | 0.726 |
| no-MMR emb=0.8 bump=1 | 0.967 | 67.1% | 67.1% | 0.726 |
| no-MMR emb=0.8 bump=1.2 | 0.967 | 67.1% | 67.1% | 0.726 |

## Default vs best

Default ranks #22 of 30.

| | MRR | R@5 | R@10 | NDCG@10 |
|---|---|---|---|---|
| default | 0.967 | 66.2% | 67.1% | 0.722 |
| best    | 1.000 | 66.2% | 67.1% | 0.745 |
| delta   | +0.033 | +0.0pp | +0.0pp | +0.022 |