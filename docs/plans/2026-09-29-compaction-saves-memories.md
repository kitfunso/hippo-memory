# Plan: hippo saves memories at every Claude Code compaction

Rev 3, after /plan-eng-review and /codex. Status: not started. It waits on a yes for two new tables (below) and on
the session-digest PR (#335) merging.

Goal (Keith, verbatim): "i want something saved before every compaction, we have compaction set at 250k, hippo should
save memories into hippo database everytime we compact". Saving means rows in hippo's DB that are kept for good.
Constraints: zero-touch, no bloat in prompts or recall, no slop, exit 0 on every hook path.

Two PRs:
- **PR 1 `feat/compaction-saves-memories`**: a compaction record in hippo.db written before and after every
  compaction, the instruction, the items, the keep rule, the own-session filter, supersede keeping origin.
- **PR 2 `feat/claude-memory-sync`**: the Claude Code auto-memory note sync rewrite, called from post-compact, init
  and sleep, with a note-state table.
Both cut from origin/master after #323 (merged) and the session-digest PR merge. At branch cut, confirm shared.ts has
`NO_MERGE_TAGS` and consolidate.ts has `keptAsWritten`; if the merged shape differs from what this plan assumes,
re-read before coding. Line numbers below are at 1f6c562; re-find each by text.

**Needs a yes before execute: two new tables (one migration per PR).** Both are schema changes to live stores.
Without them the summary goes to a file (not "into hippo database"), and a changed note is missed whenever the edit
is past character 1500 (124 of 176 notes on one real machine are longer).

## Evidence
Five real PostCompact payloads, paths scrubbed, are in `tests/fixtures/compaction/post-compact-payloads.jsonl`.
- PreCompact hook stdout reaches the summariser as instructions (Claude Code 2.1.284, Opus 5.5). The summary ends
  with a "Memories for hippo" list of standalone sentences, the user's correction included.
- With "Leave out anything an earlier summary already listed", later compactions list only new items, or "- none".
- Holds for trigger=manual (2 runs) and trigger=auto (3 runs, forced with CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=1).
- Headings in the 5 real summaries: `Memories for hippo:` (2) and `**Memories for hippo**` (3). The phrase also
  appears inside body prose ("...under 'Memories for hippo' section."), so a substring search is wrong.
- PreCompact stdin: session_id, transcript_path, cwd, trigger, custom_instructions. PostCompact stdin adds
  `compact_summary` (`<analysis>...</analysis>` then `<summary>...</summary>`). SessionStart(compact) fires between.
- Not covered: length pressure at a real 250k context (measured in use by a log line); subagent compaction.

## PR 1: compaction save

1. **Compaction record** (new table, migration): `compactions(tenant_id, id, session_id, origin_project,
   compact_trigger, cwd, transcript_path, snapshot_saved, started_at, summarised_at, summary, items_json,
   items_written, status)`, status one of `started | summarised | done`. `compact_trigger`, not `trigger` (SQL
   reserved word). Not a memory row: nothing in recall, FTS, context, dedupe or sleep's memory passes reads it, so
   none of the ten read paths rev 1 had to patch are touched.
2. **pre-compact** keeps the snapshot. When a store resolves (hookStoreRoot, cli.ts:7262):
   - inserts the record with status `started` (this is the "something saved before every compaction", even when no
     snapshot is derivable, capture.ts:1333);
   - prints the instruction below with `fs.writeSync(1, ...)` before `process.exit(0)` (capture.ts:1419); the
     "Nothing goes to stdout" comment (capture.ts:1408-1410) is replaced.
   No store: print nothing, write nothing. The `pre-compact-last.json` report (preCompactReportPath,
   capture.ts:1205) is deleted: postCompactMessage (capture.ts:1431-1460) reads `snapshot_saved` from its own
   session's record, so two sessions compacting at once cannot cross, and there is no file to sweep.
3. **post-compact** (cli.ts:10445-10453): read stdin, do the work, then print exactly one line (design 9). Each step
   is independent: a failure logs to stderr and the next runs.
   a. **Record the summary** first, in one short statement: the `<summary>` body with `<analysis>` removed, through
      `redactSecretsStrict` (secret-detect.ts:105), cap 256 KB, plus every parsed item in full in `items_json`;
      status `summarised`. Updates the session's latest `started` record, or inserts one if pre-compact wrote none.
   b. **Items**: write through the shared gated write (design 7); `items_written` and status `done` in the same
      transaction as the last item. Missing section: log "no memories section" (the length-pressure measure).
   c. No embedding in the hook. capture's fire-and-forget embed call (capture.ts:984) keeps Node alive past the
      hook's `break`; items get vectors from the next embedAll or sleep backfill.
   d. **Busy store**: the hook opens the DB with a short wait (about 2s; openHippoDb, db.ts:2593, gains an option;
      its journal-mode retry waits 30s today, db.ts:2579, past the hook's 10s). If it cannot write, it spools the
      payload's summary to `<store>/compactions-spool/<session_id>-<ts>.json` and exits 0.
4. **Replay** (closes the killed-hook and busy-store windows): sleep, and the next post-compact, finish any record
   left `summarised` for over 10 minutes (the repeat skip makes this idempotent), import spool files, and fill a
   `started` record older than 10 minutes from its transcript's `isCompactSummary` entry written after started_at.
   The instruction keeps "leave out anything an earlier summary already listed": with replay, a listed item reaches
   the DB even when its own hook died.
5. **Parser** (pure function, `src/compaction-items.ts`).
   - Heading: the LAST line whose text, after stripping leading `#`, `*`, `N.` and whitespace and trailing `*`,
     `:` and whitespace, equals `memories for hippo` (case-insensitive). Covers `Memories for hippo:`,
     `**Memories for hippo**`, `## Memories for hippo`, `10. Memories for hippo:`. A mention inside a sentence
     never matches. The heading line is never an item.
   - Items: lines starting (after any indent) with `- `, `* ` or `N.`/`N)`. A nested bullet is its own item. An
     indented line with no marker joins the previous item. Blank lines between items are allowed. The list ends at
     `</summary>`, or at the first non-blank line that is neither an item nor an indented continuation.
   - Drop "none" (any case, with or without a full stop). No cutting: an item over 500 chars stays in the record
     only, logged "item too long". At most 10 items become rows; the rest stay in the record, logged "capped".
6. **Item rows**: `kind: 'distilled'`, `layer: Episodic`, `confidence: 'observed'`, tag `compaction-memory`,
   source `compaction:<session_id>`, `source_session_id: <session_id>`.
   - **Kept for good by a keep rule on tag AND source**: a row is kept when it carries `compaction-memory` and its
     source starts `compaction:` (PR 2 adds `claude-code-memory` + `claude-memory:`). Both, because merge copies
     every source tag onto its merged row (consolidate.ts:862 after #323, source `'consolidation'`): a tag-only rule
     would keep merged rows forever. `canAutoDelete` (memory.ts:495; Pick gains `tags`, `source`) and
     `AUTO_DELETABLE_SQL` (memory.ts:494, `NOT (instr(tags_json, '"<tag>"') > 0 AND source LIKE '<prefix>%')` per
     pair) change together. Callers: audit.ts:131, consolidate.ts:213 (`retirable`, gates decay and dormancy),
     dedupe.ts:144; SQL at store.ts:2015, 2112, 2206; comment at api.ts:3492 updated. Not exported from index.ts.
   - What the keep rule does not do: **dedupe never removes a kept row** (dedupe.ts:144 skips any row
     canAutoDelete refuses), so the repeat skip is the only dedupe for items. **Conflict detection** keeps a kept row
     only while its strength is at or above 0.05 (consolidate.ts:1082); at the default 365-day half-life that is
     years for an unrecalled row. Accepted and said, not patched.
   - **Origin**: rows written through the global fallback get `origin_project = deriveOriginProject(payload.cwd)`
     (project-identity.ts:251) before the write (stampOriginProject keeps a preset value, store.ts:1590-1593). A
     folder with no project marker (project-identity.ts:120-122) gives `''`, user-global, same as capture and
     remember there. A working folder that holds many repos and has no git of its own is this case, and its
     sessions do span projects.
   - **Repeats**: skip an item when a live `compaction-memory` row with the same tenant AND origin_project has the
     same `duplicateKey` (same-text.ts: equal apart from spacing; case and punctuation kept). Lookup and insert run
     in one `BEGIN IMMEDIATE`, so two sessions writing the same text cannot both insert. Loaded by SQL, never
     loadAllEntries.
7. **One gated write** shared by capture, compaction items and (PR 2) the note sync: createMemory options in, then
   isContentWorthStoring (audit.ts:181), the secret veto, writeEntry, RejectedValueError (rejection.ts:45) as a
   skip; returns `'written' | 'skipped:<reason>'`. Capture's write path (capture.ts:945-986) moves onto it, keeping
   its embed call outside. No new behaviour for capture.
8. **Supersede keeps provenance**: api.supersede's createMemory (api.ts:2050-2059) copies `origin_project` and
   `source_session_id` from the old row. Today it drops origin, and stampOriginProject (api.ts:2097) then derives it
   from the store: in the global store every superseded project row turns user-global. Root fix, all rows.
9. **PostCompact message**, the only stdout line: "Hippo saved 3 memories from this compaction and restored your
   task snapshot." Zero items: "Hippo kept this compaction's summary; it listed no new memories." Spooled: "Hippo
   will finish saving this compaction at the next sleep."
10. Store: `hookStoreRoot(hippoRoot)`. No store: log "skip: no hippo store", exit 0. Any error: log, exit 0.
11. Keep items out of places that would bloat or distort:
    - Add `compaction-memory` to `NO_MERGE_TAGS` (shared.ts, from the digest PR): not merged, never sent to LLM
      extraction (which otherwise sends Episodic rows to api.anthropic.com when ANTHROPIC_API_KEY is set).
    - Items stay in conflict detection (its own list), within the strength limit above.
    - **Own-session filter inside `admit`** (api.ts:2613): drop `compaction-memory` rows whose `source_session_id`
      equals `opts.currentSessionId`. Filtering in admit, not after, matters: the store loader fetches a window of
      max(needed x 4, 32) rows and only widens when admit leaves too few (store.ts:2341-2346), and prompt recall's
      `eligible` also calls admit (api.ts:2773). The context hook already passes the id (cli.ts:7034). Explicit
      `hippo recall` is not filtered.

Instruction text (pre-compact stdout; tested verbatim):
"In your summary, add a last section titled 'Memories for hippo'. List, one per line starting with '- ', each lesson
learned, decision made (with its reason) and correction the user gave in this session that should outlive it.
Write each as a standalone sentence that names its subject. Leave out anything an earlier summary already listed
under 'Memories for hippo'. Write '- none' if nothing new remains."

## PR 2: Claude Code auto-memory sync

One function replaces `learnFromMemoryMd` (cli.ts:3000-3085), built on its #323 version (storedTextKeys +
duplicateKey), moved to `src/claude-memory-sync.ts`, used by init (cli.ts:726), sleep (cli.ts:3285) and post-compact
(after items). Test importers move with it: tests/claude-memory-import.test.ts, tests/importer-secret-veto.test.ts,
tests/writers-configured-half-life.test.ts.
- **Note-state table** (new, migration): `claude_memory_notes(tenant_id, source_key, body_sha256, memory_id,
  synced_at, PRIMARY KEY (tenant_id, source_key))`. The hash is of the full body, so an edit past the 1500-char
  content cap (cli.ts:3034) is still seen. The primary key makes two concurrent first imports of one note collide
  instead of both inserting; lookup and write run in one `BEGIN IMMEDIATE`.
- Dir: `dirname(transcript_path)/memory/*.md` at post-compact; claudeMemoryFolderNames at init and sleep.
- Key: `claude-memory:<claude project folder>/<file>`, folder name lowercased on win32 on both the payload side and
  the claudeFolderName side (cli.ts:2990), so keys match. Rows use it as their source.
- Unchanged hash: skip. Changed: new row plus the old row's `superseded_by` (api.supersede's CAS pattern) and the
  state row updated, one transaction. Writes go through the shared gated write.
- Rows: distilled, tag `claude-code-memory`; KEEP gains the `claude-code-memory` + `claude-memory:` pair, and
  `claude-code-memory` joins `NO_MERGE_TAGS` (a note is kept as written, never folded into a merged row).
- **Deleted note: the row loses its keep tag** and the state row goes, so normal decay applies. A note Claude
  deleted as wrong must not be kept and injected forever. A missing memory folder is not "every note deleted":
  skip deletion handling then.
- A note whose old row went dormant (dormant.ts purges those after 180 days) gets a live row at the next sync,
  because the state lookup finds no live memory. No dormant-purge exemption needed; the file is the source.
- Legacy rows keyed `claude-memory:<file>` are adopted at init and sleep only (claudeMemoryFolderNames spawns git
  with a 10s timeout), and only for the store's own project folders.
- Returns counts; never prints. Init and sleep print their own line; post-compact folds the counts into its one line.
- Keeps: frontmatter required, `MEMORY.md` skipped, 1500-char content cap, secret veto, rejection guard. The bare
  catch (cli.ts:3074) becomes a logged skip. Existing imported rows become kept; the changelog says so.

## Loss windows
- Summariser omits the section: the record still holds the summary; "no memories section" logged; no items for that
  compaction. Accepted and measured.
- Post-compact killed or the store busy: the record (or a spool file) holds the summary and items; replay writes them
  at the next sleep or post-compact. A `started` record with no summary is filled from the transcript.
- PostCompact 10s timeout (hooks.ts:925-930): record first, SQL loads only, no embedding, short DB wait. No timeout
  change (the installer only adds missing hooks); verify logs the hook's duration.
- No store for the folder: no instruction, no record, no items. Same as the snapshot.

## Tests (named after the behaviour; seeded through initStore/createMemory/writeEntry)
PR 1:
- parser: both real heading shapes, `##` and numbered headings, the phrase inside prose not matched, heading line not
  an item, `-`/`*`/numbered items, nested bullets, wrapped lines joined, blank lines between items, "- none",
  missing section, list ended by `</summary>`, 11 items (10 rows, all 11 in the record), a 600-char item kept in the
  record only.
- pre-compact: record inserted as `started` and the instruction printed once via fd 1 when a store exists; nothing
  when none; snapshot still written; two sessions' records and messages do not cross.
- post-compact from `tests/fixtures/compaction/post-compact-payloads.jsonl`: record `done` with the summary (analysis
  dropped, a planted fake secret redacted) and items; transcript fallback; no store = no write, exit 0; one failing
  step does not stop the next; stdout is exactly one line.
- interruption: kill after the record step, then sleep writes the items once; a held write lock makes the hook spool
  within its budget and exit 0, and sleep imports the spool; a `started` record is filled from the transcript.
- repeats: a second compaction's repeated item is skipped; spacing-only change is a repeat, case change is not; the
  same text from another project (global store) is written.
- kept for good: sleep with decay forced deletes nothing kept and moves none to dormant; a merged row carrying the
  tag (source `consolidation`) is not kept; `hippo forget` and `hippo supersede` still work.
- canAutoDelete and AUTO_DELETABLE_SQL agree, table-driven over pinned x kind x tags x source, including a tag that
  contains a keep tag as a substring.
- supersede keeps origin_project and source_session_id (global store row stays in its project).
- not merged, not sent to extraction (fake key set, extraction asserted not called); still in conflicts.
- global fallback: items carry the payload cwd's origin, are not admitted in another project, are not copied by
  syncGlobalToLocal; a markerless folder gives user-global.
- own session: with 40 same-session items the recent slots still fill with older rows; with `promptRecall: true`
  none of the session's items are injected; another session sees them.
- capture on the shared gated write: existing capture tests pass unchanged.
PR 2:
- new note imported; unchanged skipped; an edit past char 1500 supersedes; two concurrent first imports give one
  row; deleted note loses its keep tag and state row and nothing else; missing folder changes nothing; a note whose
  row is dormant gets a live row; legacy key adopted at sleep in the store's own project only, never in the hook;
  Windows folder case normalised; secret note skipped; nothing printed; notes are never merged.

## Docs
README hooks section, CLI help for pre-compact/post-compact, doctor label (doctor.ts "compaction snapshot and
capture" becomes true; doctor also counts records stuck in `started` or `summarised`), hooks.ts header, the Claude
Code init block sentence plus its SHIPPED_HOOK_HASHES entry, AGENTS.md, dogfood guide section 2, CONTEXT.md terms
"Compaction record", "Compaction memory" and "Keep rule", ROADMAP "Reversed 2026-09-29" bullets (a record, not a
summary memory row), changelog.d fragments (PR 1 `### Added`; PR 2 `### Changed`, noting imported auto-memory rows
are now kept). No em dashes; house word list.

## Verify (drive the real flow)
1. Build; scratch project whose hooks call the built dist.
2. Manual `/compact` twice and forced auto compactions: one record per compaction (`done`), items once, right
   counts in the PostCompact message, hook duration logged.
3. `hippo sleep` with ANTHROPIC_API_KEY set and unset: rows present, none merged, none extracted.
4. recall/context: items found; the same session's next prompt does not re-inject them.
5. Count cross-producer repeats (session-end capture, digest, sync, items) on one real session.
6. A subagent that compacts (or a note that it never does): whether the hooks fire and which session_id they carry.

## Out of scope
Codex, Cursor, OpenCode, OpenClaw, Pi (no compaction hooks; said in docs). An LLM extraction call. Backfilling old
transcripts. A reader command for compaction records. The PostCompact timeout migration unless verify shows a need.
A capture on/off setting (none exists). The 1500-char note content cap itself (124 of 176 notes on one real machine
are cut in recall today): a separate prompt-size question, raised with Keith, not changed silently.

## Review log
Rev 1 reviewed by senior-code-reviewer (Opus), verdict "approve with fixes". Taken: 1 (origin from cwd), 2 (extraction),
3 (summary to a file), 4 (keep tag, not raw), 6 (own-session recent slots), 7 (writeSync, store check, per-session
report), 8 (sync keys, legacy adoption off the hook, bare catch), 9 (items stay in conflicts), 10 (measure repeats).
Rejected: 5's timeout migration (not needed unless verify shows the hook near 10s); 1's "skip the note sync unless a
local store exists" (with origin stamped, notes from a folder without a store should still reach the global store,
which is the gap the audit found).

Rev 2 reviewed by /plan-eng-review (Opus, source-checked at 1f6c562) and /codex (xhigh, 12 findings, each re-read in
source before use).
- Taken from plan-eng-review: two PRs; deleted note drops its keep tag; dedupe claim corrected; duplicateKey for
  repeats; session-id hedge dropped; SQL loads only in the hook; one stdout line; one shared gated write; no
  embedding in the hook; parser cases from the real headings; subagent check; SQL/function agreement test;
  redaction cite fixed. The per-session report sweep became moot (the record replaces the report file).
- Taken from codex: summary into a DB record written before and after compaction, not a file (1); keep rule on tag
  AND source, notes never merged (2); replay of listed-but-unwritten items, busy-store spool (3); repeats split by
  origin, case kept (4); supersede keeps origin (6); BEGIN IMMEDIATE and a primary key for first imports (7);
  session filter inside admit, covering the loader window and prompt recall (8); full-body hash, no item cutting
  (11); the digest dependency checked at branch cut (12).
- Rejected from codex: dropping the "leave out earlier items" instruction (3; replay covers the loss, and the premise
  check showed it prevents repeats); a stable folder identity for markerless folders (5; changes origin rules for
  every writer, and user-global is right for a multi-project folder; the claim is corrected instead); admitting
  faded kept rows to conflict detection (9; years away at the default half-life, pairwise cost grows; the claim is
  corrected instead); a dormant-purge exemption (10; the sync re-imports from the note file).
