### Changed

- **Shared helpers and named constants replace copies and magic numbers, with no change in behaviour.** `JsonValue` and `isJsonString` now live once in `src/json.ts` (14 type copies and 12 function copies folded into one each), and `escapeLike` and `escapeRegex` live once in `src/escape.ts` (8 copies, two of them inline, folded into two). The 4000-token recall budget, the 1.2 local-over-global bump and its 1/1.2 global discount, and the 256-character id cap are named constants. Unused imports and variables went from 68 lint hits to 2, and the lint baseline is lowered to match.
