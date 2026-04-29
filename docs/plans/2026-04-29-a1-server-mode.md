# A1 Server Mode Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship `hippo serve` — a persistent daemon that exposes HTTP + MCP, with the CLI auto-detecting it and becoming a thin client. SQLite single-writer for v1.

**Architecture:** One process owns the DB. The server owns it; concurrent CLI invocations transparently route HTTP to the server when a pidfile is present. Lift business logic out of `src/cli.ts` handlers into `src/api.ts` callable functions that both the server and direct CLI use, so the CLI can run with or without a server. Auth (A5 API keys) flows through HTTP headers; audit events stamp `actor='api_key:hk_xxx'` for HTTP requests, `'cli'` for direct local CLI. MCP gets a second transport (HTTP/SSE) alongside stdio.

**Tech Stack:** Node's built-in `node:http` (no new deps), TypeScript, vitest with real CLI + real HTTP. Reuses A5 auth/audit/tenant primitives. Existing `src/mcp/server.ts` stdio path stays for compat — A1 adds HTTP/SSE transport beside it.

---

## Schema diagram

### Before (post-A5, v16)

```
.hippo/
├── hippo.db                  ← SQLite (WAL mode, single writer)
├── memories/                 ← markdown mirror
├── episodic/, semantic/, ...
└── (no server metadata)

src/cli.ts                    ← all command handlers, calls store.ts directly
src/mcp/server.ts             ← stdio MCP transport, calls store.ts directly
```

### After (A1)

```
.hippo/
├── hippo.db
├── memories/
├── server.pid                ← {pid, port, url, started_at, version} — written on serve, deleted on shutdown
├── server.log                ← rolling log (rotate at 10 MB)
└── ...

src/api.ts                    ← NEW — callable domain layer (remember/recall/forget/promote/supersede/archive/auth/audit). Pure functions taking {hippoRoot, tenantId, actor} as context.
src/server.ts                 ← NEW — HTTP server. Routes to api.ts. Validates Authorization: Bearer hk_... header.
src/server-detect.ts          ← NEW — pidfile read + health probe. Returns {url, sessionToken?} or null.
src/cli.ts                    ← UPDATED — handlers check server-detect first. If server alive: HTTP roundtrip. Else: direct api.ts call.
src/mcp/server.ts             ← UPDATED — splits into stdio (existing) + http-sse (new). Both backed by api.ts.
```

**Single-writer rule.** When `hippo serve` is running, all writes MUST go through it. CLI invocations detect the pidfile and route via HTTP. If the pidfile is present but the server is unreachable (stale pidfile after crash), the CLI prints a warning, deletes the pidfile, and falls back to direct DB access.

**Auth.** HTTP requests carry `Authorization: Bearer hk_<plaintext>`. Server validates via `validateApiKey`. Without a key, the server accepts requests from `127.0.0.1` only (loopback trust, matches stub auth model). Remote requests require an API key.

**Audit.** HTTP requests audit with `actor='api_key:<key_id>'` (or `'localhost:cli'` for unauthenticated loopback). Direct CLI calls (no server running) keep `actor='cli'`.

---

## Task list (sequence)

1. `src/api.ts` skeleton — domain interface + remember
2. `src/api.ts` — recall, forget, promote, supersede
3. `src/api.ts` — archive_raw, auth (create/list/revoke), audit (list)
4. CLI handlers route through `src/api.ts` (no behavior change yet, just refactor)
5. `src/server-detect.ts` — pidfile read + health probe
6. `src/server.ts` — HTTP skeleton: start, health, shutdown
7. HTTP routes — remember, recall, forget, promote, supersede, archive
8. HTTP routes — auth, audit
9. Auth middleware — Bearer token validation, loopback exception
10. CLI thin-client mode — detect server, HTTP roundtrip, fall back on stale pidfile
11. MCP/HTTP transport — `hippo serve` exposes MCP-over-HTTP/SSE in addition to existing stdio
12. Concurrent recall+write test harness (real DB, multiple clients)
13. p99 recall benchmark on 10k-memory store
14. 24h soak harness (skeleton only, run is manual / cron)
15. Eval re-run + bump to v0.36.0

Effort: 4w solo. ~15 commits + bump. The first 4 land the refactor (no user-visible change). Tasks 5-11 add the server. Tasks 12-14 are the success-criterion gate.

---

## Conventions

- **Tests use real DB and real CLI.** Mock-free. Server tests use real HTTP via `node:http` client + a test port (random above 30000).
- **Pidfile is `.hippo/server.pid`** — JSON, atomic write via temp + rename. Read with stale-check (process probe).
- **Default port 6789.** Override via `--port` flag or `HIPPO_PORT` env.
- **No new deps.** `node:http` only. JSON parsing native. Streaming via `node:stream`.
- **Bite-sized commits.** Every task ends with a passing test and one commit.
- **NEVER --no-verify.** No em dashes in commit messages.
- **Auth model.** Loopback (`127.0.0.1`) without API key returns `actor='localhost:cli'`. Non-loopback without key → 401. Any source with a valid API key → `actor='api_key:<key_id>'`.

---

### Task 1: `src/api.ts` skeleton + remember

**Files:**
- Create: `src/api.ts`
- Test: `tests/api-remember.test.ts`

**Step 1: Failing test**

```typescript
// tests/api-remember.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, readEntry } from '../src/store.js';
import { remember } from '../src/api.js';

describe('api.remember', () => {
  it('persists a memory and returns its envelope', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-api-rem-'));
    initStore(home);
    const result = remember({
      hippoRoot: home,
      tenantId: 'default',
      actor: 'cli',
    }, {
      content: 'api-canary-remember-77',
      kind: 'distilled',
    });
    expect(result.id).toMatch(/^mem_/);
    expect(result.kind).toBe('distilled');
    const stored = readEntry(home, result.id);
    expect(stored?.content).toBe('api-canary-remember-77');
    expect(stored?.tenantId).toBe('default');
    rmSync(home, { recursive: true, force: true });
  });

  it('emits an audit event with the supplied actor', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-api-rem-'));
    initStore(home);
    remember({ hippoRoot: home, tenantId: 'default', actor: 'api_key:hk_test' },
             { content: 'audit-trail-canary' });
    const { openHippoDb, closeHippoDb } = await import('../src/db.js');
    const { queryAuditEvents } = await import('../src/audit.js');
    const db = openHippoDb(home);
    const events = queryAuditEvents(db, { tenantId: 'default', op: 'remember' });
    expect(events[0]!.actor).toBe('api_key:hk_test');
    closeHippoDb(db);
    rmSync(home, { recursive: true, force: true });
  });
});
```

**Step 2: Run, fail.**

**Step 3: Implement `src/api.ts`**

```typescript
import type { DatabaseSyncLike } from './db.js';
import { openHippoDb, closeHippoDb } from './db.js';
import { writeEntry } from './store.js';
import { createMemory, type MemoryKind, type MemoryEntry } from './memory.js';
import { appendAuditEvent } from './audit.js';

export interface Context {
  hippoRoot: string;
  tenantId: string;
  actor: string; // 'cli' | 'localhost:cli' | 'api_key:<key_id>' | 'mcp'
}

export interface RememberOpts {
  content: string;
  kind?: MemoryKind;
  scope?: string;
  owner?: string;
  artifactRef?: string;
  tags?: string[];
}

export interface RememberResult {
  id: string;
  kind: MemoryKind;
  tenantId: string;
}

export function remember(ctx: Context, opts: RememberOpts): RememberResult {
  const entry = createMemory({
    content: opts.content,
    kind: opts.kind ?? 'distilled',
    scope: opts.scope,
    owner: opts.owner,
    artifactRef: opts.artifactRef,
    tags: opts.tags,
    tenantId: ctx.tenantId,
  });
  writeEntry(ctx.hippoRoot, entry);

  // Audit with the supplied actor (overrides the cli-default in writeEntry's hook).
  // writeEntry already audits with actor='cli' via its internal helper; we want the
  // server's actor to land instead. Strategy: pass actor through as a param to
  // writeEntry, OR audit again with the correct actor and rely on the test asserting
  // the LATEST event. The cleaner fix is to thread actor into writeEntry — see Task 4.
  // For now, append a duplicate event with the right actor and let Task 4 deduplicate.
  const db = openHippoDb(ctx.hippoRoot);
  try {
    appendAuditEvent(db, {
      tenantId: ctx.tenantId,
      actor: ctx.actor,
      op: 'remember',
      targetId: entry.id,
      metadata: { kind: entry.kind, scope: entry.scope ?? null },
    });
  } finally {
    closeHippoDb(db);
  }

  return { id: entry.id, kind: entry.kind ?? 'distilled', tenantId: ctx.tenantId };
}
```

**Step 4: Run, see pass. Note: the audit double-emit is intentional pending Task 4 (which threads actor through writeEntry).**

**Step 5: Commit**

```bash
git add src/api.ts tests/api-remember.test.ts
git commit -m "feat(a1): src/api.ts skeleton + remember domain function"
```

---

### Task 2: api.ts — recall, forget, promote, supersede

**Files:**
- Modify: `src/api.ts`
- Test: `tests/api-domain.test.ts`

Mirror the same shape: each function takes `(ctx, opts)`, calls into store.ts/cli.ts logic, returns plain data.

**Functions to add:**

```typescript
export interface RecallOpts { query: string; limit?: number; mode?: 'bm25' | 'hybrid' | 'physics'; }
export interface RecallResult { results: Array<{ id: string; content: string; score: number; ... }>; total: number; tokens: number; }

export function recall(ctx: Context, opts: RecallOpts): RecallResult { ... }
export function forget(ctx: Context, id: string): { ok: true; id: string } { ... }
export function promote(ctx: Context, id: string): { ok: true; sourceId: string; globalId: string } { ... }
export function supersede(ctx: Context, oldId: string, newContent: string): { ok: true; oldId: string; newId: string } { ... }
```

Each emits the corresponding audit event with `ctx.actor`.

**Tests** mirror api-remember.test.ts: assert behavior + assert audit event has correct actor.

Run, pass, commit:
```
feat(a1): api.ts - recall, forget, promote, supersede
```

---

### Task 3: api.ts — archive_raw, auth, audit

**Files:**
- Modify: `src/api.ts`
- Test: append to `tests/api-domain.test.ts`

```typescript
export function archiveRaw(ctx: Context, id: string, reason: string): { ok: true; archivedAt: string } { ... }
export function authCreate(ctx: Context, opts: { label?: string; tenantId?: string }): { keyId: string; plaintext: string } { ... }
export function authList(ctx: Context, opts: { active: boolean }): ApiKeyListItem[] { ... }
export function authRevoke(ctx: Context, keyId: string): { ok: true; revokedAt: string } { ... }
export function auditList(ctx: Context, opts: { op?: AuditOp; since?: string; limit?: number }): AuditEvent[] { ... }
```

Each delegates to existing primitives (`createApiKey`, `revokeApiKey`, `archiveRawMemory`, `queryAuditEvents`).

Commit:
```
feat(a1): api.ts - archive_raw, auth, audit
```

---

### Task 4: CLI handlers route through api.ts

**Files:**
- Modify: `src/cli.ts` (cmdRemember, cmdRecall, cmdForget, cmdPromote, cmdSupersede, cmdAuthCreate/List/Revoke, cmdAuditList)
- Modify: `src/store.ts` writeEntry — accept optional `actor: string` so the audit hook uses the supplied actor
- Modify: `src/api.ts` remember — drop the duplicate audit emit now that writeEntry handles it
- Test: existing tests must still pass (no behavior change)

**Goal:** every CLI handler becomes a thin wrapper that builds a `Context` and calls into `src/api.ts`. No user-visible behavior change. Removes the audit double-emit from Task 1.

For each handler:
1. Build `ctx = { hippoRoot, tenantId: resolveTenantId({}), actor: 'cli' }`
2. Call `api.<op>(ctx, opts)`
3. Format the result for stdout / JSON output

**Verify:** `npx vitest run` — all 766 existing tests + new api-* tests still green.

**Commit:**
```
refactor(a1): CLI handlers delegate to src/api.ts (no behavior change)
```

---

### Task 5: `src/server-detect.ts` — pidfile + health probe

**Files:**
- Create: `src/server-detect.ts`
- Test: `tests/server-detect.test.ts`

**Step 1: Failing tests**

```typescript
// tests/server-detect.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectServer, writePidfile, removePidfile } from '../src/server-detect.js';

describe('server-detect', () => {
  it('returns null when no pidfile exists', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-pidf-'));
    expect(detectServer(home)).toBeNull();
    rmSync(home, { recursive: true, force: true });
  });

  it('returns null when pidfile exists but process is dead', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-pidf-'));
    mkdirSync(join(home, '.hippo'), { recursive: true });
    writeFileSync(join(home, '.hippo', 'server.pid'),
      JSON.stringify({ pid: 99999999, port: 6789, url: 'http://127.0.0.1:6789', started_at: new Date().toISOString() }));
    expect(detectServer(home)).toBeNull();
    // Stale pidfile should have been deleted
    expect(() => require('node:fs').readFileSync(join(home, '.hippo', 'server.pid'))).toThrow();
    rmSync(home, { recursive: true, force: true });
  });

  it('writePidfile + removePidfile roundtrip', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-pidf-'));
    mkdirSync(join(home, '.hippo'), { recursive: true });
    writePidfile(home, { port: 6789, url: 'http://127.0.0.1:6789' });
    const detected = detectServer(home);
    expect(detected?.url).toBe('http://127.0.0.1:6789');
    expect(detected?.pid).toBe(process.pid);
    removePidfile(home);
    expect(detectServer(home)).toBeNull();
    rmSync(home, { recursive: true, force: true });
  });
});
```

**Step 3: Implement**

```typescript
// src/server-detect.ts
import { existsSync, readFileSync, writeFileSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export interface ServerInfo {
  pid: number;
  port: number;
  url: string;
  started_at: string;
}

const PIDFILE = '.hippo/server.pid';

export function detectServer(hippoRoot: string): ServerInfo | null {
  const path = join(hippoRoot, PIDFILE);
  if (!existsSync(path)) return null;
  let info: ServerInfo;
  try {
    info = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    try { unlinkSync(path); } catch {}
    return null;
  }
  // Probe the process. Sending signal 0 throws if the pid is dead or owned by
  // another user we can't signal. Either way, treat as stale.
  try {
    process.kill(info.pid, 0);
  } catch {
    try { unlinkSync(path); } catch {}
    return null;
  }
  return info;
}

export function writePidfile(hippoRoot: string, opts: { port: number; url: string }): void {
  const path = join(hippoRoot, PIDFILE);
  const tmp = `${path}.tmp.${process.pid}`;
  const info: ServerInfo = {
    pid: process.pid,
    port: opts.port,
    url: opts.url,
    started_at: new Date().toISOString(),
  };
  writeFileSync(tmp, JSON.stringify(info));
  renameSync(tmp, path);  // atomic
}

export function removePidfile(hippoRoot: string): void {
  const path = join(hippoRoot, PIDFILE);
  try { unlinkSync(path); } catch {}
}
```

Pass, commit:
```
feat(a1): server-detect - pidfile + health probe
```

---

### Task 6: `src/server.ts` HTTP skeleton — start, health, shutdown

**Files:**
- Create: `src/server.ts`
- Test: `tests/server-lifecycle.test.ts`

**Test asserts:**
- `serve()` returns a `{ port, stop }` handle
- `GET /health` returns 200 with `{ ok: true, version, started_at }`
- `stop()` closes the HTTP listener and removes the pidfile
- Lifecycle: start → health → stop → second start succeeds (no port leak)
- SIGTERM / SIGINT handler calls stop (probe via signal — but be careful in vitest; may skip on Windows)

**Implementation outline:**

```typescript
// src/server.ts
import { createServer, type Server } from 'node:http';
import { writePidfile, removePidfile } from './server-detect.js';

export interface ServerHandle {
  port: number;
  url: string;
  stop: () => Promise<void>;
}

export interface ServeOpts {
  hippoRoot: string;
  port?: number;       // 0 = ephemeral
  host?: string;       // default '127.0.0.1'
}

export async function serve(opts: ServeOpts): Promise<ServerHandle> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? Number(process.env.HIPPO_PORT ?? 6789);

  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, version: '0.35.0', started_at: new Date().toISOString() }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  const actualPort = (server.address() as { port: number }).port;
  const url = `http://${host}:${actualPort}`;
  writePidfile(opts.hippoRoot, { port: actualPort, url });

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    removePidfile(opts.hippoRoot);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  // Best-effort signal handlers. Skip in vitest environment to avoid orphaning the test runner.
  if (!process.env.VITEST) {
    process.once('SIGTERM', () => { void stop(); });
    process.once('SIGINT', () => { void stop(); });
  }

  return { port: actualPort, url, stop };
}
```

Test uses `port: 0` to get an ephemeral port and avoid collisions.

Commit:
```
feat(a1): server.ts - HTTP skeleton with /health, lifecycle, pidfile
```

---

### Task 7: HTTP routes — remember, recall, forget, promote, supersede, archive

**Files:**
- Modify: `src/server.ts`
- Test: `tests/server-routes-domain.test.ts`

Each route delegates to `src/api.ts`. JSON in, JSON out. Errors → 4xx with `{ error: string }`.

Routes:
- `POST /v1/memories` body `{ content, kind?, scope?, ... }` → `{ id, kind, tenantId }`
- `GET  /v1/memories?q=...&limit=10` → `{ results, total, tokens }`
- `DELETE /v1/memories/:id` → `{ ok: true, id }`
- `POST /v1/memories/:id/promote` → `{ ok: true, sourceId, globalId }`
- `POST /v1/memories/:id/supersede` body `{ content }` → `{ ok: true, oldId, newId }`
- `POST /v1/memories/:id/archive` body `{ reason }` → `{ ok: true, archivedAt }`

**Tests** spin the server on port 0, hit each route via `fetch()` (Node 18+ native), assert response shapes.

Commit:
```
feat(a1): HTTP routes - remember, recall, forget, promote, supersede, archive
```

---

### Task 8: HTTP routes — auth, audit

Routes:
- `POST /v1/auth/keys` body `{ label?, tenantId? }` → `{ keyId, plaintext }`
- `GET /v1/auth/keys?active=true` → `[{ keyId, tenantId, label, createdAt, revokedAt }]`
- `DELETE /v1/auth/keys/:keyId` → `{ ok: true, revokedAt }`
- `GET /v1/audit?op=&since=&limit=&json` → `[AuditEvent]`

Commit:
```
feat(a1): HTTP routes - auth and audit
```

---

### Task 9: Auth middleware — Bearer token + loopback exception

**Files:**
- Modify: `src/server.ts` (insert middleware before route dispatch)
- Test: `tests/server-auth.test.ts`

**Behavior:**
- Read `Authorization: Bearer <token>` header
- If present: `validateApiKey(db, token)` → if valid, ctx.actor = `api_key:<keyId>`, ctx.tenantId = key's tenant_id
- If absent and `req.socket.remoteAddress` is `127.0.0.1` or `::1`: ctx.actor = `localhost:cli`, ctx.tenantId = `resolveTenantId({})` (env)
- If absent and remote address is non-loopback: 401 with `{ error: 'auth required' }`

**Tests:**
- Loopback no-auth → 200, audit shows `localhost:cli`
- Loopback with valid key → 200, audit shows `api_key:hk_xxx`
- Loopback with invalid key → 401
- Non-loopback no-auth → 401 (simulate via `Forwarded:` header or by binding to non-loopback in a test fixture; if too fragile on the test runner, document the gap and fall back to a unit test of the middleware function)

Commit:
```
feat(a1): server auth middleware - Bearer token + loopback exception
```

---

### Task 10: CLI thin-client mode — detect server, route via HTTP

**Files:**
- Modify: `src/cli.ts` — at the top of main, call `detectServer(hippoRoot)`. If non-null, set a flag and route command handlers through HTTP instead of api.ts directly.
- Create: `src/client.ts` — thin HTTP wrapper. One function per route. Returns the same shape as `src/api.ts`.
- Test: `tests/cli-thin-client.test.ts`

**Test:**
- Spin up server in a child process (`spawn` from `node:child_process`, run `node dist/cli.js serve --port 0 --json-port-on-start`)
- Wait for pidfile to appear
- Run `node dist/cli.js remember "..."` in a separate process — must hit the server, not write to DB directly
- Verify the audit event from the second process shows actor=`localhost:cli` (loopback, no key)
- Stop server, verify pidfile is gone
- Run `hippo remember` again — must fall back to direct mode (actor=`cli`)

This is the headline test for A1: "CLI thin-client → server → response round-trip parity with direct CLI" from the ROADMAP commitments.

Commit:
```
feat(a1): CLI thin-client mode - HTTP roundtrip when server detected
```

---

### Task 11: MCP-over-HTTP/SSE transport

**Files:**
- Modify: `src/server.ts` — add `GET /mcp/stream` (SSE) and `POST /mcp` (request) routes
- Modify: `src/mcp/server.ts` — extract message-handling into a transport-agnostic dispatcher; stdio and HTTP both feed it
- Test: `tests/server-mcp-http.test.ts`

**Goal:** any MCP client that supports HTTP/SSE transport can talk to `hippo serve` instead of spawning a stdio child.

The MCP spec for HTTP transport: client opens SSE stream for incoming server messages, posts JSON-RPC requests to the request endpoint, server matches by id and pushes responses to the SSE stream.

**Test:** open SSE stream via `fetch()` with `accept: text/event-stream`, post a `tools/list` request, assert the response arrives on the stream within 1s.

Commit:
```
feat(a1): MCP-over-HTTP/SSE transport, stdio path unchanged
```

---

### Task 12: Concurrent recall + write test

**Files:**
- Test: `tests/server-concurrency.test.ts`

**Behavior:**
- Start server on port 0
- Seed 100 memories
- Spawn N=10 concurrent reader clients (each does 50 recalls in parallel)
- Spawn 1 writer client (does 50 remembers serialized)
- Assert: all reads succeed, all writes succeed, no SQLite locked errors, final memory count is exactly 150

This is "Concurrent recall + write under SQLite single-writer (real DB)" from ROADMAP.

Commit:
```
test(a1): concurrent recall + write under single-writer
```

---

### Task 13: p99 recall benchmark on 10k store

**Files:**
- Create: `benchmarks/a1/p99-recall.ts`
- Test: `tests/server-p99.test.ts` (skipped by default, run manually or in CI nightly)

**Benchmark spec (pinned per ROADMAP):**
- Query mix: top-10 BM25 against tier-1 micro-eval queries
- Cold cache (fresh server start)
- Hybrid embeddings on
- Single SQLite connection
- Store: 10k memories (synthetic but realistic distribution)

**Run:**
```bash
node dist/benchmarks/a1/p99-recall.js --store-size 10000 --queries 1000
```

Outputs JSON: `{ p50, p95, p99, p999, mean, stddev, total_ms }`.

**Success criterion:** p99 < 50ms. If not, the failing run reports which queries took longest so we can profile (FTS, embedding lookup, JSON serialization, etc.).

This is informational at this stage. The CI gate is in Task 15.

Commit:
```
feat(a1): p99 recall benchmark on 10k store
```

---

### Task 14: 24h soak harness skeleton

**Files:**
- Create: `benchmarks/a1/soak.ts`
- Documentation in CHANGELOG / README

**Goal:** a runnable harness that drives the server with realistic load for N hours and tracks RSS, FD count, SQLite WAL size, and request latency over time. The actual 24h run is a manual / scheduled task — this plan delivers the harness, not the result.

```bash
node dist/benchmarks/a1/soak.js --hours 24 --concurrency 4 --rps 20
```

Writes `benchmarks/a1/soak-<timestamp>.jsonl` with periodic samples. Plot in any tool.

Commit:
```
feat(a1): 24h soak harness skeleton (results pending manual run)
```

---

### Task 15: Eval re-run + version bump to 0.36.0

**Files:** package.json + 3 manifests, CHANGELOG.md, README.md

**Pre-flight:**
- `npm run build` — clean
- `npx vitest run` — 766+30 ≈ 796+ green
- `python benchmarks/micro/run.py` — 9/9 at 100%
- `node dist/benchmarks/a1/p99-recall.js --store-size 10000` — p99 < 50ms (the success criterion)
- Manual smoke: `hippo serve` in one terminal, `hippo remember "..."` in another, verify both behave correctly

If p99 >= 50ms, document in CHANGELOG as a known issue and file a v0.37.0 follow-up rather than blocking ship. The headline value of A1 is the architecture, not necessarily hitting the latency target on day one.

Bump 0.35.0 → 0.36.0. CHANGELOG entry covers serve / thin-client / MCP-HTTP / auth / concurrent-write / p99 result.

README "What's new in v0.36.0":
- `hippo serve` daemon mode
- CLI auto-detects and becomes thin client
- MCP-over-HTTP transport
- p99 recall < 50ms on 10k store (or known-issue note)
- Bearer-token auth on remote requests, loopback trust for local CLI

Hand off to `/publish-repo` skill.

---

## Footguns to watch

1. **Stale pidfile after crash.** If the server hard-crashes (OOM, kill -9), the pidfile sticks around. `detectServer` probes via signal 0 — that handles dead PIDs. But if the system has reused the PID for an unrelated process, the probe returns true and the CLI tries to talk to that process. Mitigation: include `started_at` in the pidfile; on health probe, compare `process.uptime()` reported by the server to `started_at`. Mismatch → treat as stale.

2. **SQLite single-writer + WAL.** WAL mode (`src/db.ts:384`) allows concurrent readers. Only one writer can hold the lock at a time. If the server is the canonical writer and a CLI invocation tries to write directly (no server detection, fallback path), they'll fight. The pidfile-routing should prevent this, but for safety, the CLI's direct-write path should set `PRAGMA busy_timeout = 5000` (already there) and surface a clear error if the lock can't be acquired.

3. **Loopback trust.** Treating `127.0.0.1` as authenticated is fine for stub auth, but **`hippo serve --host 0.0.0.0`** would expose it to the network. Add a startup warning: "binding to non-loopback host without API key requirement is not recommended." Or refuse to start without auth on non-loopback. Latter is safer — go with that.

4. **Audit double-emit during the refactor (Task 1 → Task 4).** Task 1 emits a duplicate audit event because writeEntry already audits. Task 4 cleans this up by threading actor through writeEntry. Don't ship between Task 1 and Task 4 — the dirty audit log is unshippable.

5. **Concurrent write races.** SQLite single-writer means writes serialize at the DB level, but the server's HTTP handlers can interleave. If two simultaneous remember requests both compute `mem_id = uuid()` and try to insert, both succeed (different ids). Fine. But if two requests both try to UPDATE the same row (e.g., supersede the same id), the last write wins. Mitigation: optimistic locking via the existing `updated_at` field. Defer to v2 unless a real race shows up in Task 12 testing.

6. **Process exit during request.** Server gets SIGTERM mid-request. `server.close()` waits for in-flight requests by default, but if the request handler is awaiting a slow operation (consolidation), shutdown blocks indefinitely. Add a 30s drain timeout, then `socket.destroy()` on remaining connections.

7. **Pidfile clobber on multi-host shared FS.** Two `hippo serve` instances on different machines pointing at the same NFS-mounted `.hippo`. Each writes its own pidfile. `process.kill(other_pid, 0)` returns true if the local kernel has that PID for an unrelated process. This is a v2 concern — document and move on.

8. **Test runner isolation.** Server tests must use `port: 0` (ephemeral) and unique `hippoRoot` (mkdtemp). Otherwise CI flakes. Seen this pattern in tests/recall-tenant-isolation.test.ts.

---

## Out of scope (v2 / A2)

- **A2 — RESTish HTTP API hardening.** SDK examples, contract polish, OpenAPI spec. A1 ships the surface; A2 productizes it.
- **Authentication beyond stub.** OAuth, SCIM provisioning, multi-tenant per-key scoping. Already deferred under A5 v2.
- **Multi-process writers.** SQLite Litestream, Postgres backend (A6), or rqlite. v1 stays single-writer.
- **TLS termination.** Run behind nginx / Caddy if remote. Server itself is plain HTTP.
- **Rate limiting per tenant.** Stub auth = single tenant per deployment, no rate limit needed yet.
- **Streaming responses.** Server-sent events for context assembly is a nice-to-have for A2; A1 ships JSON only.
- **Hot reload of API keys.** Revoking a key doesn't invalidate in-flight requests — they complete. Acceptable for stub.
