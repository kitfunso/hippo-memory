# One sleep per store: a Sleep claim held by an operating system lock

Date: 2026-11-10
Status: accepted
Links: `changelog.d/fix-one-sleep-per-store.md`; `src/store/sqlite/consolidation/sleep-lock.ts`; `src/api/sleep/one-sleep.ts`; `tests/consolidate/sleep-one-per-store.process.test.ts`

## Context
Nothing at the store stopped two sleeps from running at once. The only guard was an in-process latch (`AutoSleepHost.latch`) that one auto-sleep host reads. A `hippo sleep` from a hook, a scheduled sleep, an MCP auto-sleep and a server sleep could all overlap on one store, and each of them read the same unextracted source memories and sent them to the model.

## Constraints and evidence
- Two real `hippo sleep --no-learn` processes on one store, with a stub of the Anthropic Messages API, were inside model calls at the same time for about 3.8 s, and both exited 0.
- With a stub that words each fact the same way, the final rows matched a serial run. The model was called 24 times instead of 12, and the audit log held 24 `remember` and 17 `forget` events against 14 and 4.
- With a stub that words the same fact two ways, as a real model does, the overlapped run stored a second copy of facts: 35 memories against 26 serial, and 9 of 11 sources carried two extracted facts against 0. The dedupe pass removes only text that is equal apart from spacing, so nothing later removed the second copy. The second wording came from the stub, so this shows that an overlapped sleep can store a second worded copy, not how often a real model does.
- The model-independent harm is the doubled model spend and the extra audit events.
- `runConsolidation` is the one function below both guarded entry points, and it lives in `src/domain/consolidate/`, which this change does not edit. The guard sits in the api layer, above `runSleep` and `runConsolidation`.
- Operating system locks are already how `replay.lock.db` and `embeddings.lock.db` work. `docs/UPGRADING-3.0.md:183` records that the older pid-and-age lock files were replaced by them.

## Decision
The term is **Sleep claim**: the right to run a sleep on a store. One holder at a time; the operating system keeps it and frees it when its holder dies.
- The claim is `sleep.lock.db` in the store folder, taken through `takeFileLock` (SQLite `BEGIN IMMEDIATE` on a small lock database). `Consolidation` gains the optional members `claimSleep` and `releaseSleep`.
- Dead-owner rule: the operating system lock decides, with no pid check and no age cutoff. A killed holder cannot leave the claim behind, so an age cutoff would only add a way to break a live sleep.
- `oneSleepPerStore` in `src/api/sleep/one-sleep.ts` takes the claim before the sleep starts and gives it back in `finally`. It guards `sleepWholeStore` and `autoSleepConsolidate`, the two functions every entry point reaches.
- A sleep that finds the claim held does nothing. `hippo sleep` prints one line, `A sleep is already running on this store (since <ISO time>), so this one skipped consolidation.`, and exits 0. The result gains `alreadyRunning: { since }` with every count at 0.
- `since` is the mtime of the lock file, stamped by path when the holder takes the claim.
- A dry run writes nothing, so it takes no claim and is never refused.
- A folder that cannot keep a lock file (unreadable, read-only) logs one warning per folder per process and runs unguarded, as before.
- An auto-sleep that is refused makes the MCP stdio host wait 60 seconds before it tries again. The server host has no backoff, because its queue runner returns nothing.

## Alternatives considered
- **Make extraction idempotent:** re-read `extractedFrom` before each write. It leaves the doubled model calls, and the dag, merge and replay passes each need a guard of their own.
- **Reuse `replay.lock.db`:** it sits in the spool folder, and `hippo sleep` replays that spool before it consolidates. One file would make a sleep refuse its own replay, or make a hook's replay refuse a sleep.
- **A pid file with an age cutoff:** the design 3.0 replaced for the other locks (`docs/UPGRADING-3.0.md:183`). An age cutoff can break a live sleep.
- **A meta row in `hippo.db`:** a sleep that dies holding it leaves the row behind, so it needs a stale-row rule. The operating system lock needs none.

## Consequences
- A new empty file `sleep.lock.db` appears in a store folder on its first real sleep. It holds no data and is reused.
- On master only `src/store/sqlite/vectors/embed-lock.ts:7`, `tests/core/embed-lock-backoff.test.ts`, `tests/store/embed-lock.process.test.ts` and `docs/UPGRADING-3.0.md:183` name `embeddings.lock.db`. No ignore list or backup list names a lock file, so none needs `sleep.lock.db`.
- Not guarded: the published `consolidate()` in `src/entry/sleep.ts`, whose return type is `ConsolidationResult`. A library host that calls it beside a CLI sleep still races.
- The `hippo sleep` pre-steps (git learn, agent-note import, replay, repairs) run before the claim, so a refused sleep has already run them. The claim guards consolidation only.
- A refused sleep writes no `consolidate` audit event and no `consolidation_runs` row.
- A refusal that lands between the holder's take and its stamp can read the previous sleep's time for `since`.

## Reconsider when
- `src/surface/server/sleep-offload.ts` can change: the server queue could report a refusal and share the 60-second backoff.
- The library `consolidate()` gets a result type that can carry a refusal.
