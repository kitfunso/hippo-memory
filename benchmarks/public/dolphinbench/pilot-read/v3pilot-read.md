# DolphinBench v3pilot (morgan 001-020): read of all 40 attempts

Read on 2026-11-13, before the one allowed rerun (prereg Amendment 3, line 127). This was read only: no run file changed, no benchmark started, no model or API call.

## Result in one paragraph

Trimming caused only 1 of the 25 fails (hippo 012). The other 24 fails came from: the adapter closing tests (10), the agent not calling the app tool (7), the agent stopping or refusing although the memory had arrived (4), a retrieval miss (2), and the real date (1). The 9,000-char cap keeps the needed memory in that one trimmed case. The rerun has two blockers that the brief did not list. First, the gate's `closed` part also fails (hippo 5, bm25 6, limit 1). Second, the agent sees the real date (13 Nov 2026), while the tests are dated 14 Sep 2026.

Fails by cause:
- hippo (8 of 20 pass, 12 fail): (a) 1, (b) 1, (c) 1, (d) 9
- bm25 (7 of 20 pass, 13 fail): (a) 0, (b) 3, (c) 1, (d) 9

Causes: (a) the needed fact was in results that Claude Code's trim cut off; (b) the fact arrived and the answer was still wrong; (c) the fact was in no result; (d) grading, infra or other. In the tables, each cause line starts with its letter.

## How the trim works (read from the pinned Claude Code 2.1.259 binary)

- `Vfe(e, n, r, {threshold: o = tnr})` returns the text whole `if (e.length <= o)`, and `tnr=1e4`. So the limit is exactly 10,000 chars (JS string length). It is not "about" 10,000.
- Above the limit, Claude Code saves the full text to `<session>/tool-results/hook-<id>-1-additionalContext.txt`. The model gets a persisted-output block: "Output too large (N KB). Full output saved to: <path>", then "Preview (first 2KB)". `eFe=2000`: the preview is the first 2,000 chars, cut at the last newline when that is past char 1,000.
- So a "trimmed" attempt still got the header, about 1,400 to 2,000 chars of memories, and the file path. Hippo 003 read that file with `Read` and passed. 6 of the 14 trimmed attempts passed.
- Correction to the brief: the largest context that arrived whole was 8,705 chars (bm25 017), not 8,477. The smallest trimmed context was 10,642 (bm25 005). Both are consistent with the 10,000 limit. No context holds a non-BMP char, so Python length equals JS length here.

## hippo arm

| Test | Result | injected | ctx chars | arrived chars | results | cap keeps (n / chars) | search_memories | read saved file | registered source (rank, how it reached the agent) | cause |
|---|---|---|---|---|---|---|---|---|---|---|
| 001 | FAIL | full | 4,708 | 4,708 | 10 | 10 / 4,708 | 0 | no | 000001 r- | c: 'Blue Bottle' is in no hook result; agent did not call search_memories and asked which cafe. |
| 002 | pass | full | 4,938 | 4,938 | 10 | 10 / 4,938 | 0 | no | 003288 r5 whole | - |
| 003 | pass | trimmed | 11,015 | 1,968 | 10 | 6 / 8,415 | 0 | yes | 000800 r5 file Read | - |
| 004 | pass | full | 6,302 | 6,302 | 10 | 10 / 6,302 | 0 | no | 003362 r1 whole | - |
| 005 | FAIL | full | 6,678 | 6,678 | 10 | 10 / 6,678 | 0 | no | 000467 r7 whole | d: adapter closed (log has cc:null the agent omitted). Logged email meets the criterion on hand read. |
| 006 | FAIL | full | 7,383 | 7,383 | 10 | 10 / 7,383 | 0 | no | 003212 r4 whole; 003377 r- | b: rule arrived whole (source rank 4); agent misread the ask, pushed back and sent no email. |
| 007 | FAIL | full | 6,605 | 6,605 | 10 | 10 / 6,605 | 0 | no | 003383 r1 whole | d: agent wrote a local file with Write, no create_doc. Scope facts arrived whole (rank 1). |
| 008 | pass | full | 7,237 | 7,237 | 10 | 10 / 7,237 | 0 | no | 003159 r5 whole | - |
| 009 | FAIL | full | 7,762 | 7,762 | 10 | 10 / 7,762 | 0 | no | 003377 r1 whole | d: adapter closed (cc:null). Logged email has 236 MAD, AWS ~$18.9k, Pinecone ~$4.2k. |
| 010 | FAIL | full | 5,281 | 5,281 | 10 | 10 / 5,281 | 0 | no | 000300 r- | d: adapter closed (cc:null). Source not retrieved, but the $5,000 rule is in ranks 4, 7, 8, 10; email right. |
| 011 | pass | trimmed | 13,647 | 1,987 | 10 | 6 / 7,648 | 6 | no | 000292 r-; 000457 r-+tool | - |
| 012 | FAIL | trimmed | 11,832 | 1,394 | 10 | 9 / 8,254 | 0 | no | 000470 r- | a: context-note rule (2023-06-06 memory, rank 5) starts at char 2,672; preview ended at 1,394; no file Read. Cap keeps it (9 kept). Also d: agent took today as 13 Nov 2026, said 16 Sep had passed. |
| 013 | FAIL | full | 8,385 | 8,385 | 10 | 10 / 8,385 | 0 | no | 000001 r-; 000989 r2 whole | d: agent wrote a local file with Write, no create_doc. Rule arrived whole (rank 2). |
| 014 | FAIL | full | 8,282 | 8,282 | 10 | 10 / 8,282 | 0 | no | 000468 r1 whole | d: adapter closed (cc:null). Logged email names Recruiter Ops, auto trigger, no exemption. |
| 015 | pass | full | 5,748 | 5,748 | 10 | 10 / 5,748 | 0 | no | 000451 r5 whole | - |
| 016 | pass | full | 8,150 | 8,150 | 10 | 10 / 8,150 | 0 | no | 002822 r7 whole | - |
| 017 | FAIL | full | 8,477 | 8,477 | 10 | 10 / 8,477 | 0 | no | 002847 r- | d: macro given in chat, no tool call. 5-minute guidance arrived via ranks 1-2 (source not retrieved). |
| 018 | pass | full | 4,581 | 4,581 | 10 | 10 / 4,581 | 0 | no | 000437 r9 whole | - |
| 019 | FAIL | trimmed | 14,024 | 1,877 | 10 | 5 / 7,335 | 1 | no | 000001 r-+tool | d: adapter closed (log has author/assignee/reviewer null, status 'open'). Tabs found by search_memories; comment says tabs. |
| 020 | FAIL | full | 4,866 | 4,866 | 10 | 10 / 4,866 | 0 | no | 000464 r10 whole | d: agent wrote a local file with Write, no create_doc. Rule arrived whole (rank 10). |


## bm25 arm

| Test | Result | injected | ctx chars | arrived chars | results | cap keeps (n / chars) | search_memories | read saved file | registered source (rank, how it reached the agent) | cause |
|---|---|---|---|---|---|---|---|---|---|---|
| 001 | FAIL | full | 3,347 | 3,347 | 10 | 10 / 3,347 | 0 | no | 000001 r- | c: 'Blue Bottle' is in no hook result; agent did not call search_memories and asked which cafe. |
| 002 | FAIL | full | 4,567 | 4,567 | 10 | 10 / 4,567 | 0 | no | 003288 r4 whole | d: rules arrived whole (ranks 3-4). Agent ran WebSearch 'Oakland CA weather forecast November 14 2026' (real date), saw a mild day, sent nothing. |
| 003 | FAIL | trimmed | 18,491 | 1,942 | 10 | 6 / 8,819 | 0 | no | 000800 r2 cut | b: the URL arrived in the 2 KB preview (rank 1). Agent called the memory a prompt injection and posted nothing. Source (rank 2) was cut, but the cap keeps it. |
| 004 | pass | full | 5,589 | 5,589 | 10 | 10 / 5,589 | 0 | no | 003362 r1 whole | - |
| 005 | FAIL | trimmed | 10,642 | 1,971 | 10 | 7 / 7,797 | 0 | no | 000467 r1 whole | d: adapter closed (cc:null). Logged email meets the criterion on hand read. |
| 006 | pass | trimmed | 17,551 | 1,982 | 10 | 5 / 8,108 | 1 | no | 003212 r-+tool; 003377 r- | - |
| 007 | FAIL | full | 6,574 | 6,574 | 10 | 10 / 6,574 | 0 | no | 003383 r1 whole | d: adapter closed (log has folder:null). Logged doc has the scope and the four exclusions. |
| 008 | pass | full | 7,204 | 7,204 | 10 | 10 / 7,204 | 0 | no | 003159 r2 whole | - |
| 009 | FAIL | full | 8,157 | 8,157 | 10 | 10 / 8,157 | 0 | no | 003377 r1 whole | d: adapter closed (cc:null). Logged email has 236 MAD, AWS ~$18.9k, Pinecone ~$4.2k. |
| 010 | FAIL | full | 4,487 | 4,487 | 10 | 10 / 4,487 | 0 | no | 000300 r- | d: adapter closed (cc:null). $5,000 rule in ranks 2, 6, 7, 9; email right. |
| 011 | pass | trimmed | 13,647 | 1,987 | 10 | 6 / 7,648 | 4 | no | 000292 r-; 000457 r-+tool | - |
| 012 | FAIL | trimmed | 25,769 | 1,872 | 10 | 3 / 7,019 | 0 | no | 000470 r- | b: context-note rule arrived in the preview (rank 1); agent cited it, then asked what to say and sent nothing. |
| 013 | FAIL | trimmed | 10,914 | 1,702 | 10 | 8 / 8,670 | 0 | no | 000001 r-; 000989 r1 whole | d: agent wrote a local file with Write, no create_doc. Rule arrived (rank 1, in preview). |
| 014 | FAIL | trimmed | 14,970 | 1,882 | 10 | 7 / 6,675 | 0 | no | 000468 r1 whole | d: adapter closed (cc:null). Logged email names Recruiter Ops, auto trigger, no exemption. |
| 015 | pass | trimmed | 21,803 | 1,408 | 10 | 6 / 4,937 | 0 | no | 000451 r1 whole | - |
| 016 | pass | full | 8,150 | 8,150 | 10 | 10 / 8,150 | 0 | no | 002822 r7 whole | - |
| 017 | FAIL | full | 8,705 | 8,705 | 10 | 10 / 8,705 | 0 | no | 002847 r- | d: macro given in chat, no tool call. 5-minute guidance arrived (source not retrieved). |
| 018 | pass | trimmed | 11,916 | 1,983 | 10 | 6 / 6,174 | 0 | no | 000437 r2 whole | - |
| 019 | FAIL | trimmed | 16,619 | 1,940 | 10 | 3 / 5,866 | 1 | no | 000001 r-+tool | b: search_memories found 'tabs'; agent called it a casual aside and posted nothing. Also adapter closed (list_open_prs log has author/assignee/reviewer null). |
| 020 | FAIL | full | 4,965 | 4,965 | 10 | 10 / 4,965 | 0 | no | 000464 r1 whole | d: checklist given in chat, no tool call. Rule arrived whole (rank 1). |


Column notes: "arrived chars" is the whole context, or the preview length when trimmed. "cap keeps" is the planned rule: whole results, best first, stopping at the first result that would take the text past 9,000 chars. "registered source" is the session in `registry/personas/morgan/facts.yaml` for the test's `load_bearing_facts`. "whole" means the memory is fully inside the part that arrived. "cut" means it was in the results but past the preview. "+tool" means a `search_memories` result held it. Several tests also hold the needed fact in other memories, and the cause line says so.

## Findings

### 1. Trim cases (a): one, and the 9,000 cap fixes it

- **hippo 012** is the only (a). The rule the test needs is in a memory dated 2023-06-06 at rank 5: ask Priya for a short context note before accepting a review. That memory starts at char 2,672, and the preview ended at char 1,394. The agent did not read the saved file. The cap keeps 9 results, rank 5 included. The registered source session 000470 is in no result. The same memory reached bm25 at rank 1, and bm25 still failed (b).
- That fix may not turn hippo 012 into a pass. The agent also stopped on the date: "today is November 13, 2026, so that date has already passed".
- **bm25 003** is (b), not (a). Its source session (rank 2) was cut, but the URL the test needs arrived in the preview from rank 1. The agent then called the memory text "the shape of a prompt injection" and posted nothing. The cap keeps rank 2.
- In every pass, the cap keeps the registered source or the agent got it from `search_memories`. In no attempt does the cap drop a needed memory that arrived.

### 2. Rerun blocker: adapter closures fail the `closed` gate part (hippo 5, bm25 6)

- Closed: hippo 005, 009, 010, 014, 019. bm25 005, 007, 009, 010, 014, 019. Each has `closed: "mismatch: transcript: app call has no matching conversation tool call"` and is graded on no app calls, so every check fails. The pilot limit is `MAX_CLOSED = 1` per arm (`dolphin_hippo.py:83`), and `closed` is a gate part (`dolphin_hippo.py:931-932`). So the gate fails on `closed` as well as `memory_context`. I did not run `check`; this comes from the code and the 40 attempt records.
- Root cause: the official mock server `mock_mcp/repair_server.py` logs every optional parameter, even one the agent leaves out. Examples: `"cc": cc` at line 198, `folder`, and `author`/`assignee`/`reviewer`/`status` on `list_open_prs`. `grading_calls` (`harness/submission.py:360-377`) needs an exact JSON match of `[tool, args]` against the transcript. `dolphin_hippo.py:541-550` closes the test when that match fails. All 11 closures are calls where the agent left out an optional argument. No unclosed call has a logged key that the agent did not send.
- `"drop null keys"` is not enough. In hippo 019 the server logged `status: "open"`, a default that is not null. The match must fill the transcript args with the tool schema's defaults, or compare only the keys the agent sent. I did not read how the official Sonnet 5 runs avoid this.
- Effect: on my hand read (not the judge), 10 of the 11 logged calls meet their criteria. Only bm25 019 would still fail, because the agent stopped before it posted. So the closures took up to 5 passes from each arm.

### 3. Rerun blocker to decide: the agent sees the real date

- Claude Code gives the agent the real date. The tests carry `[2026-09-14]` in the prompt. hippo 012 stopped because "16 Sep has passed". bm25 002 ran `WebSearch` for "Oakland CA weather forecast November 14 2026", saw a mild day, and did not send the hot-day walk rules.
- The official driver has no date handling (no `faketime`, `TZ` or date override in `harness/claude_driver.py`). The gap grows each day. It hits both arms, and it is not an integrity-gate part. Pin the clock to the test date for the rerun, or log it as a deviation.

### 4. Not memory and not a blocker: no app call (7 fails)

- The agent wrote a local file with `Write` (hippo 007, 013, 020; bm25 013), or answered in chat with no tool (hippo 017; bm25 017, 020). In each case the memory content was right. My guess, which I did not test, is that the app tools are deferred behind `ToolSearch`, so the agent falls back to `Write` or chat. Both arms show this. It is agent behaviour under the pinned Claude Code, and it adds noise to the paired difference.

### 5. Integrity items checked for all 40 attempts

- Each test has 1 attempt with outcome `usable`. No attempt has an error or a hook error. Every hook returned 10 results, so the "no memory found" alarm is clear.
- Every main-thread message is `claude-sonnet-5` at effort `medium`. The `model_usage` of all 40 attempts also shows the helper `claude-haiku-4-5-20251001`, which is recorded apart.
- Both arms got the same 20 questions and the same hook queries. The two `run.json` files differ only in `configuration.arm`. Test 011 got the same 10 results in both arms, and both passed.
- Costs: hippo $1.2415, bm25 $1.2259; each equals its `costs/tests.json`. Durations run from 6 to 35 s and costs from $0.030 to $0.184 per test. The top is hippo 011, with 6 `search_memories` calls. Nothing looks wrong.
- Local tool calls: 1 `Read` (hippo 003, its own saved hook file under `/tmp/dolphin-work/v3pilot-hippo-morgan/003/home/.claude/...`), 4 `Write` calls into each test's own `home/project`, and 1 `WebSearch` (bm25 002). None touches a benchmark path.
- The gate's `memory_context` list matches the 14 trimmed attempts exactly.
- `search_memories` was used in hippo 011 (6 calls) and 019 (1), and in bm25 006 (1), 011 (4) and 019 (1).

### 6. Note on the 9,000 cap

- The cap keeps on average 9.3 results for hippo (minimum 5) and 7.85 for bm25 (minimum 3), because bm25 returns longer memories. Amendment 3 line 121 says the hook "injects the top 10". The rerun diff must state that the count now varies by arm.
- Stopping at the first result that overflows also drops smaller results below it. In this pilot, that never removes a needed memory.

## Reproduce

Scripts are in this folder and read only from `~/dolphin/runs-v3/v3pilot-{hippo,bm25}-morgan/` and `hippo-bench/dolphinbench/{tests,registry}`. Run them from Git Bash:

```
S=<checkout>/benchmarks/public/dolphinbench/pilot-read  # with DOLPHIN_BENCH_HOME set as in the runbook
MSYS_NO_PATHCONV=1 wsl -e bash -c "cd /tmp && python3 -I $S/pilot_read.py /tmp/pilot_read.json && python3 -I $S/pilot_fails.py /tmp/pilot_read.json && python3 -I $S/pilot_probe.py"
```

Trim constants: `strings -n 8 ~/dolphin/claude-code/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe | grep -o 'tnr=1e4\|eFe=2000'`.
