### Changed
- `hippo recall` and `hippo explain` now rank through one side-effect-free `rankRecall` in `src/recall-pipeline.ts`; the commands parse every flag first and keep all printing and writes. Output, exit codes and stored rows are unchanged, pinned by a 42-case golden test.
