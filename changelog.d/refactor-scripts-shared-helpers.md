### Changed

- **Internal:** the scripts now share one seeded random generator (`scripts/lib/prng.mjs`) and one comment stripper (`scripts/lib/source-text.mjs`) instead of pasted copies. No behaviour change: every copy was checked to draw the same sequence or give the same output first.
