# Upgrading to 2.0

## Config

A `config.json` that exists but cannot be parsed, or that does not hold a JSON object, now stops the command with an error that names the file and the parse error. Before, hippo logged one warning and ran on the defaults, which silently dropped your settings (for example `sharedStore`).

To upgrade: run any hippo command, read the error, and fix the file. To go back to the defaults, delete `config.json`.

## Async api

These functions now return a Promise on every store, with or without `ctx.store`:

- `authCreate`, `authCreateSelf`, `authListRows`, `authRevoke`
- `forget`
- `outcome`, `outcomeForLastRecall`
- `supersede`, `archiveRaw`
- `remember`, `rememberLocally`
- `importVault`

What to change:

- Put `await` in front of each call. A call you do not await is a write that nobody waits for.
- A refusal now rejects the Promise. A test that used `expect(() => fn()).toThrow()` must use `await expect(fn()).rejects.toThrow()`.
- `StoreReply` and `AuthRevokeReply` are removed from `hippo-memory/server`. Use `Promise<T>` and `AuthRevokeResult`.
- The generic context parameter `<C extends Context>` is removed from these functions. Pass a plain `Context`.

### The lastRecall store group

The last recall and its trace now go through an optional store group, `lastRecall`. Its types, `LastRecall` and `LastRecallWrites`, are exported from `hippo-memory/server`.

- `sqliteStore` and `workerSqliteStore` have the group.
- On a store without the group, `outcomeForLastRecall` and an `outcome` call with a `traceId` reject with `StoreNotPortedError`, which the server answers as 501.
- A served sqlite store now accepts `outcome` with a `traceId`. Before, it refused one.
- `context` on a store without the group still works. It writes the recall's audit rows but keeps no last recall.

### Store groups replace the store kind

Hippo no longer reads `store.kind` to decide what a store can do. `kind` is now only a name for logs and errors. Three new optional groups do that work:

- `localFiles` names the store's hippo.db folder. A store without it gets the request fence, no auto-sleep, and 501 on `POST /v1/sleep` and the other local-only routes.
- `auditMaintenance` runs the quality audit, its repairs and the audit-log prune.
- `lessonWrites` runs git learn.

`sqliteStore` and `workerSqliteStore` have all three groups.

What to change:

- An add-on store that spreads `sqliteStore(...)` and sets its own `kind` now also has `localFiles`. Set `localFiles: undefined` to keep hippo.db fenced.
- Put `await` in front of `auditMemoryQuality`, `removeAuditErrors`, `repairMemoryQuality`, `repairMemoryQualityOnce`, `pruneAuditLog` and `learn`. Each one rejects with `StoreNotPortedError` (a 501) on a store without its group.
- `remember` now returns `halfLifeDays` and `tags`. `POST /v1/memories` sends both fields in its reply.

## Entry shape

`MemoryEntry.tenantId` is now `tenant_id`, and `summary_dirty` is a `boolean` (it was `0 | 1`). `createMemory(text, { tenantId })` keeps its option name and sets `entry.tenant_id`.

- `writeEntry` throws `TypeError('tenantId was renamed to tenant_id in 2.0')` for an entry that has `tenantId` and no `tenant_id`. Without the check, a 1.x caller would write into the `default` tenant.
- Export JSON: `hippo export` now writes `tenant_id` and a boolean `summary_dirty`. Update any script that reads `tenantId` or compares `summary_dirty` to `0` or `1`.
- Dormant memories saved by 1.x keep working; hippo reads their old fields on load.
