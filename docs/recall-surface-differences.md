# Recall surface differences

Recall has three surfaces: CLI `hippo recall` (`src/cli/recall.ts`), MCP `hippo_recall` (`src/mcp/recall-tools.ts`) and HTTP `GET /v1/memories` (`src/server/routes/recall.ts`). The same query on the same store gives a different answer on each one. This file lists the 17 differences found in the code. Each one is pinned by `tests/recall-surface-parity-golden.test.ts`; the test comments name the entries they pin (D1 to D17).

When a change closes a difference, update its entry and the goldens in the same PR, and add one changelog line for each surface whose output moves.

## Ranking

- **D1 Ranking core.** CLI ranks with `rankRecall` (`src/recall-pipeline.ts`). MCP ranks under the `showRanked` callback of `retrieve` (`retrieveFromStore` in `src/api/recall.ts`). HTTP keeps the SQL BM25 load order plus a churn sort, unless `mode` asks for hybrid or physics. CLI and MCP default to physics search.
- **D2 Candidate window.** CLI loads 200 rows per store. MCP loads at least 1,000 rows; `scorer_window` only shapes the fresh-tail and summary appendix. HTTP loads `scorer_window` rows, 200 by default.
- **D3 Global store.** Only CLI searches the global store (`HIPPO_HOME`), and only CLI writes a `recall` audit row there.
- **D4 Scores.** HTTP scores are list positions, `1 - idx / limit`, in every mode; `mode=hybrid` and `mode=physics` only reorder. CLI and MCP scores come from the search engine. MCP prints no score; its trace stores the engine score.
- **D5 Result count.** CLI fits the token budget with no default limit. MCP ranks a 50-row band and shows what fits the budget. HTTP returns `limit` rows, 10 by default, and has no budget.
- **D6 Goal boost.** CLI applies the goal-stack boost once, in `rankRecall`. HTTP applies it once, to the position scores. MCP applies it twice: to the ranked list, then again to the band's position scores.

## Side effects

- **D7 Strengthening and stats.** CLI strengthens the rows it shows, in the local and global stores, and adds them to `total_recalled`. HTTP strengthens every row it returns and adds them to `total_recalled`. MCP strengthens the rows it shows and never updates `total_recalled`.
- **D8 Audit count.** The CLI and HTTP `recall` audit rows count the rows returned. The MCP row counts the 50-row band, not the rows the budget let it show.
- **D9 Audit order and actor.** CLI writes `recall_anchor_skipped_no_session` before `recall`, as actor `cli`. HTTP writes them in the same order, as the key's subject. MCP writes `recall` first, as `mcp`.
- **D10 Trace and token ledger.** CLI traces with pipeline `cli`, MCP with `mcp` and HTTP with `api`. The ledger surfaces are `recall`, `mcp_recall` and `http_recall`; the MCP row records 0 items.
- **D11 Session ring.** Each surface keeps its own anchoring ring per tenant and session, so a repeat on one surface is a first recall on another. CLI and MCP create the ring before ranking and judge the hint against the list they show. HTTP creates the ring only after a successful recall and judges the hint against the first returned row.

## Validation, MCP against HTTP

- **D12 Empty query.** HTTP returns 400 `q is required`. MCP runs the recall.
- **D13 `scorer_window`.** HTTP returns 400 above 1,000; MCP has no cap. For 0, a negative or a non-number, both reject with `invalid_scorer_window`: HTTP as a 400 with that code, MCP as a raw `RecallContractError` that the transport turns into a JSON-RPC error.
- **D14 `fresh_tail_count`.** HTTP returns 400 for a negative or non-numeric value. MCP ignores a negative value and returns an `isError` result for a non-number.
- **D15 `fresh_tail_session_id`.** HTTP returns 400 above 256 characters. MCP has no cap.
- **D16 Surface-only arguments.** HTTP has `limit` and `mode` and rejects bad values with 400; MCP ignores both. MCP has `budget` and rejects a negative one; HTTP ignores it. MCP rejects a non-boolean `summarize_overflow`; HTTP reads any value other than `1` or `true` as false. Both cap `session_id` at 256 characters and treat a blank one as absent.
- **D17 Context.** HTTP `GET /v1/context` caps `q` at 1,024 characters and `scope` at 256, and rejects a `limit` of 0 or less. MCP `hippo_context` takes no `q` or `limit` and has no `scope` cap. Both reject a negative `budget`, with different messages. On a store whose `config.json` sets `"sharedStore": true`, HTTP needs the caller's `project` and answers 400 without it, while MCP `hippo_context` always refuses and points to `hippo_recall` (pinned by `tests/shared-store-context.test.ts`).
