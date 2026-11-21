# A memory carries its lead-in, and its identity is content plus lead-in

Date: 2026-11-21
Status: accepted
Links: PR #1282; `src/base/util/same-text.ts` (`identityText`); `src/base/records/rejection-digest.ts` (`tombstoneDigest`); `src/base/util/version.ts` (`LEAD_IN_MIN_BINARY`); `src/domain/consolidate/merge.ts:149`; `docs/ARCHITECTURE.md` (migration v64)

## Context
hippo stored each chat turn alone, so a short reply such as "Three times a week" shared no words with the question it answered and ranked low. A memory now has an optional lead-in: the conversation text just before it, in the nullable `lead_in` column (schema v64).

## Constraints and evidence
- Pre-registered LoCoMo probe, 1,527 questions, local: 1,062 found with lead-ins against 892 without (+170; the rule was +145).
- At plan time the probe gave 1,053 when recall shows the lead-in, against 925 when the lead-in is only searched.
- Before v64, an older sleep groups rows by content alone. Two rows with the same text and different lead-ins would fold into one.

## Decision
- Search reads content plus lead-in. Recall shows the lead-in above the content, and JSON carries `leadIn`.
- Identity is content plus lead-in (`identityText`). `duplicate_hash`, copy checks and the tombstone of a lead-in row key on it.
- `reject <id>` refuses the text under that lead-in only. `reject --value` refuses the text with any lead-in.
- A sleep merge leaves lead-in rows out, like a pin, because a merged row holds content only.
- Migration v64 does not move `min_compatible_binary`. The first write of a lead-in row raises it to 3.13.0, in the same transaction. Sharing that row raises the global store too.
- A lead-in goes through the secret scan, then keeps its last 2,000 characters (`MAX_LEAD_IN_CHARS`), with a warning.
- `hippo supersede` keeps the old row's lead-in. The plan left it out; codex review showed that the successor then lost the question it answered.

## Alternatives considered
- Search by the lead-in, but do not show it: 925 against 1,053 in the plan probe.
- Raise the floor at migration v64: every store refuses older binaries, even with no lead-in row.
- Never raise the floor: an older sleep can fold two lead-in rows into one.
- Merge lead-in rows and drop the lead-in: all "Yes." replies fold into one bullet.
- Every tombstone names the content: one reject removes every "Yes." reply.
- Refuse a lead-in over 4,096 characters: a long thread makes the write fail.

## Consequences
- After the first lead-in row, a binary older than 3.13.0 refuses that store, and the global store once the row is shared. The error names the fix; no data is lost.
- A 3.13 CLI that relays to an older running `hippo serve` sends `leadIn`, and that server drops it.
- The store-kit conformance suite has no lead-in case, so an add-on store built for 3.12 passes it and drops `leadIn`.

## Reconsider when
- hippo starts to dedup at write time, or a sleep merge learns to keep a lead-in.
- A store needs lead-in rows to stay open to binaries older than 3.13.0.
