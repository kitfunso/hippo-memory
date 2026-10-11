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
