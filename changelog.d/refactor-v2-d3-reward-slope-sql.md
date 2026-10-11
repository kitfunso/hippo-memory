### Changed

- **Internal:** the reward factor in SQL has one source. `rewardFactorSql()` in `rule-sql.ts` builds it for both `strengthSql` and the context-candidate rank, so a change to `REWARD_SLOPE` reaches both, and the rank now honours the outcome-slow ablation.
