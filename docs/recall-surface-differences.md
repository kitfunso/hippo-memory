# Recall surface differences

Recall has three surfaces: CLI `hippo recall` (`src/cli/recall.ts`), MCP `hippo_recall` (`src/mcp/recall-tools.ts`) and HTTP `GET /v1/memories` (`src/server/routes/recall.ts`). All three call one entry, `retrieve()` in `src/api/recall.ts`, which ranks with the ranker the surface names and writes the recall. The rankers still differ, so the same query on the same store gives a different answer on each one. This file lists the 18 differences found in the code. Each one is pinned by `tests/recall-surface-parity-golden.test.ts`; the test comments name the entries they pin (D1 to D18).

When a change closes a difference, update its entry and the goldens in the same PR, and add one changelog line for each surface whose output moves.

## Ranking

- **D1 Ranking core.** Each surface names its ranker to `retrieve`. CLI passes `cliCore`, which runs `rankRecall` (`src/api/recall-pipeline.ts`) from `src/api/recall-core.ts`, for the host admin only; `hippo explain` uses the same ranker read-only. MCP ranks under the `showRanked` callback (`retrieveFromStore` in `src/api/recall.ts`). HTTP names none and keeps the SQL BM25 load order plus a churn sort, unless `mode` asks for hybrid or physics. CLI and MCP default to physics search.
- **D2 Candidate window.** CLI loads 200 rows per store. MCP loads at least 1,000 rows; `scorer_window` only shapes the fresh-tail and summary appendix. HTTP loads `scorer_window` rows, 200 by default.
- **D3 Global store.** Only CLI searches the global store (`HIPPO_HOME`), as `cliCore.sources.globalRoot`, and only that ranker writes a `recall` audit row there.
- **D4 Scores.** HTTP scores are list positions, `1 - idx / limit`, in every mode; `mode=hybrid` and `mode=physics` only reorder. CLI and MCP scores come from the search engine. MCP prints no score; its trace stores the engine score.
- **D5 Result count.** CLI fits the token budget with no default limit. MCP ranks a 50-row band and shows what fits the budget. HTTP returns `limit` rows, 10 by default, and has no budget.
- **D6 Goal boost.** CLI applies the goal-stack boost once, in `rankRecall`. HTTP applies it once, to the position scores. MCP applies it twice: to the ranked list, then again to the band's position scores.

## Side effects

- **D7 Strengthening and stats.** CLI strengthens the rows it shows, in the local and global stores, adds them to `total_recalled` and saves the last-recall markers `hippo outcome` reads; `retrieve` does all of it. HTTP strengthens every row it returns, and `retrieve` adds them to `total_recalled` because the route sets `recordAs`. MCP strengthens the rows it shows and never updates `total_recalled`. On every surface the audit rows go first, in one transaction with the goal log: a recall whose audit write fails leaves no strengthen, trace or count. HTTP and MCP then fail the call; CLI logs the failure and still prints.
- **D8 Audit count.** Closed. Every surface's `recall` audit row counts the rows it returns or shows. MCP used to count its 50-row band.
- **D9 Audit order and actor.** CLI writes `recall_anchor_skipped_no_session` before `recall`, as actor `cli`. HTTP writes them in the same order, as the key's subject. MCP writes `recall` first, as `mcp`.
- **D10 Trace and token ledger.** CLI traces with pipeline `cli`, MCP with `mcp` and HTTP with `api`. The ledger surfaces are `recall`, `mcp_recall` and `http_recall`; the MCP row records 0 items. `retrieve` books the CLI row and, under `recordAs`, the HTTP row (`src/api/recall-finish.ts`); the MCP request handler books its own after it returns.
- **D11 Session ring.** The rings and the hint audit rows live in one module, `src/api/recall-record.ts`, keyed by surface, tenant and session. Each surface still keeps its own rings, so a repeat on one surface is a first recall on another. CLI and MCP create the ring before ranking and judge the hint against the list they show. HTTP has its ring created only after a successful recall and its hint judged against the first returned row. `retrieve` feeds the CLI and HTTP rings (`src/api/recall-finish.ts`); the MCP tool still feeds its own.

## Validation, MCP against HTTP

Both surfaces now check recall and context inputs with `parseRecallRequest` and `parseContextRequest` (`src/api/recall-request.ts`). A bad input gets the same message on both: HTTP answers 400, MCP answers an `isError` result that starts `Invalid arguments for <tool>:`. The MCP input schema still rejects a wrong type first, with its own message.

- **D12 Empty query.** Closed. HTTP rejects with `q is required`, MCP with `query is required`.
- **D13 `scorer_window`.** Closed for the cap: both reject a value above 1,000. For 0, a negative or a non-number, both reject with `invalid_scorer_window`, which `retrieve()` raises: HTTP as a 400 with that code, MCP as a raw `RecallContractError` that the transport turns into a JSON-RPC error.
- **D14 `fresh_tail_count`.** Closed. Both reject a negative value.
- **D15 `fresh_tail_session_id`.** Closed. Both cap it at 256 characters.
- **D16 Surface-only arguments.** Both check `limit` and `mode` by the same rules, but MCP then ignores them: it ranks a 50-row band in the store's search mode. MCP has `budget` and rejects a negative one; HTTP ignores it. MCP's schema rejects a non-boolean `summarize_overflow`; HTTP reads any value other than `1` or `true` as false. Both cap `session_id` at 256 characters and treat a blank one as absent.
- **D17 Context.** Both cap `scope` at 256 characters and reject a negative `budget` and a `limit` of 0 or less, with the same messages. MCP `hippo_context` takes no query text: it reads the task from git, or none on a shared store, and it ignores `limit`. HTTP caps `q` at 1,024 characters; MCP applies the same cap to a `query` argument it then ignores. On a store whose `config.json` sets `"sharedStore": true`, HTTP needs the caller's `project` and answers 400 without it. MCP `hippo_context` over HTTP reads the project from the `X-Hippo-Project` header and returns an `isError` refusal without one; over stdio it always refuses and points to `hippo_recall` (pinned by `tests/shared-store-context.test.ts`).

## Shared store, MCP against HTTP

- **D18 Project filter.** On a store whose `config.json` sets `"sharedStore": true`, MCP `hippo_recall` over HTTP shows only the rows of the repo named in `X-Hippo-Project`, plus user-global ones, and refuses a call that names no repo. HTTP `GET /v1/memories` takes no project, so it returns every repo's rows in the tenant. Backlog item E15 adds a project to the HTTP recall routes.
