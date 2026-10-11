# Upgrading to 2.0

## Security defaults

hippo 2.0 starts strict. Each default below has one explicit opt-out, so a deployment that needs the 1.x behaviour asks for it by name.

| Default in 2.0 | 1.x behaviour | Opt-out |
| --- | --- | --- |
| A keyless request from this machine (`HIPPO_ALLOW_KEYLESS_LOCAL=1`) acts as a **member**, so `POST /v1/sleep` and the three `/v1/quarantine` routes answer 403. | Host admin. | `HIPPO_KEYLESS_LOCAL_ROLE=admin`, or `serve({ keylessLocalRole: 'admin' })`. |
| A non-loopback bind without TLS **refuses to start** with `CleartextBindError`. | Started and logged one warning. | `hippo serve --allow-cleartext`, `HIPPO_ALLOW_CLEARTEXT=1`, or `serve({ allowCleartext: true })`. Use it only behind a TLS-terminating proxy. |
| `HIPPO_CLIENT_IP_HEADER` is read only from a peer listed in `HIPPO_TRUSTED_PROXIES`. With the header set and no proxy listed, the server **refuses to start** with `UntrustedClientIpHeaderError`. | Read from every peer, with one warning. | `HIPPO_TRUSTED_PROXIES=*` trusts every peer; use it only when the proxy is the server's only peer. Otherwise list the proxy addresses or CIDR ranges. |
| Each API key owner is **rate limited** to 20 requests a second, burst 40. | Off unless `rateLimits.perCaller` was set. | `HIPPO_CALLER_RPS=<n>` sets the rate (burst is twice it); `HIPPO_CALLER_RPS=0` or `serve({ rateLimits: { perCaller: 'off' } })` turns it off. |
| An API key minted with no role is a **member** key. | Unchanged; now pinned by a test. | Ask for `--role admin` (or `role: 'admin'`) by name. |

The server prints its key rule at every start, so the keyless role in force is visible in the start lines.

## `hippo watch` and `runWatched` take an argument list

`hippo watch` runs its command with **no shell**, so `;`, `&`, `|`, `$()` and `%VAR%` in an argument reach the program as written.

- Write `hippo watch -- npm run build` in place of `hippo watch "npm run build"`. A single argument with a space in it is refused, since it would otherwise run as one program name.
- To run a shell line on purpose, pass it after `--shell`: `hippo watch --shell "npm test && npm run build"`.

The exported `runWatched` changes the same way:

```ts
// 1.x
await runWatched('npm run build');
// 2.0
await runWatched(['npm', 'run', 'build']);
// 2.0, a shell line on purpose
await runWatched(['npm test && npm run build'], undefined, { shell: true });
```

On Windows a `.cmd` or `.bat` command (such as `npm`) still runs, through `cmd.exe` with every argument quoted for it.

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

## Signatures that take one options object

Long positional argument lists became options objects, and two helpers that exposed a database handle or parsed ids loosely were tightened.

- `loadRecallSearchEntries` is no longer exported from `hippo-memory`. Use `loadRecallEntries(hippoRoot, query, options)`, where `options` is `RecallSearchEntriesOptions` (`limit`, `tenantId`, `requestedScope`, `explicitScopeMode`, `includeSuperseded`, `originProjects`, `ownScope`). The positional function stays in `dist/store/search-rows.js` for the frozen benchmark.
- `resolveConflict(hippoRoot, conflictId, keepId, forgetLoser, tenantId, opts)` is now `resolveConflict(hippoRoot, { conflictId, keepId, forgetLoser, tenantId }, opts)`. `forgetLoser` defaults to `false`.
- `writeSessionEndHandoff(hippoRoot, tenantId, sessionId, evidence, derived, key, { inPlace })` is now `writeSessionEndHandoff(hippoRoot, { tenantId, sessionId, evidence, derived, key, inPlace })`. `derived`, `key` and `inPlace` are optional.
- `afterWrite` is removed from the options of `writeEntry` and `promoteToGlobal`. It handed out the write's own database handle. Code in this package that needs it uses `writeEntryWithHook` and `promoteWithHook`, which no package entry exports. Move any hook to a store method that runs inside the write.
- `hippo decide get|close` and `hippo predict show|close` reject ids such as `12abc` and `0x1` with exit code 1. They read these as `12` and `0` before. Pass a plain positive integer.
- `confidenceFacets` takes `ConfidenceInputs` (`pinned`, `confidence`, `last_retrieved`) instead of a whole `MemoryEntry`. Every old call still compiles.
