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
