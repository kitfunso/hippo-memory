### Performance

- **Hybrid search reads stored vectors without copying them, and opening a store takes one statement after its PRAGMAs.** Scoring 2,000 stored 384-number vectors used about 30 MB of copies and now uses under 2 MB; an open ran two to four statements after its PRAGMAs. Ranking, scores and replies are unchanged.
