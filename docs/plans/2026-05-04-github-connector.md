# GitHub Connector Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stream GitHub workspace events (issues, issue comments, PRs, PR review comments) into hippo as `kind='raw'` rows with full provenance, idempotency, cursor-based backfill, comment-deletion sync, scope tagging, and a dead-letter queue. The second end-to-end ingestion connector built on the A3+A5+A1 stack — proves the pattern generalizes beyond Slack and gives the v1.2 scope filter and the queued provenance CI gate a second source to police.

**Architecture:** The GitHub adapter is a thin module under `src/connectors/github/` that translates GitHub webhook events and REST backfill responses into `api.remember()` calls with `kind='raw'`, `source='github'`, `artifact_ref='github://owner/repo/<type>/<n>'`, and a `scope` derived from `repository.private`. A new HTTP route `POST /v1/connectors/github/events` verifies GitHub's `X-Hub-Signature-256` HMAC, deduplicates against a `github_event_log` table keyed on `X-GitHub-Delivery`, and routes comment deletions through `archiveRawMemory()` to honour the append-only invariant. Backfill paginates the REST API using `Link: rel="next"` headers with a per-repo cursor stored in `github_cursors`; rate-limit (403/429 + `X-RateLimit-Remaining`/`Retry-After`) responses pause and resume. Malformed events land in `github_dlq`.

**Tech Stack:** TypeScript, node:sqlite, node:http (existing A1 server), Node's built-in `crypto` (HMAC-SHA256 timing-safe), `node:fetch` for REST backfill, real DB tests via vitest (no mocks per project rule), an injectable `GitHubFetcher` interface so tests don't hit the network.

**Non-goals (V1):**
- No write-back to GitHub. Read-only adapter — zero source-system mutations.
- Discussions, releases, commit comments, workflow events: parked. V1 = issues + issue_comment + pull_request + pull_request_review_comment.
- No GitHub App installation flow. V1 = PAT via `GITHUB_TOKEN` (single-tenant) or pre-populated `github_installations` mapping (multi-tenant). App OAuth callback is V2.
- No worker queue. Webhook handler is synchronous; GitHub's 10s budget is plenty for HMAC + idempotency + one INSERT.
- No code-content ingestion (diffs, blob contents). V1 ingests issue/PR/comment **bodies** only.

**ROADMAP success criterion:** A 200-event smoke test against canned fixtures with no source-system writes; recall surfaces a real PR review comment by topic faster than transcript replay. Both must pass before tagging shipped.

---

## Release sequencing (REQUIRED — codex audit 2026-05-04)

Two P0 release-safety bugs MUST land before GitHub work begins:

1. **v1.2 scope filter is Slack-specific.** `passesScopeFilter` in `src/api.ts` and the continuity filter only default-deny `slack:private:*` and `unknown:legacy`. The moment v1.3 ingests `github:private:*`, no-scope recall leaks private GitHub rows.
2. **Rollback exposure.** Downgrading to a v1.2.x without the generalized filter after v1.3 has written private GitHub rows is a customer-data exposure.

Sequence:
- **v1.2.1 (preflight, ships first):** generalize default-deny in `src/api.ts`, `src/cli.ts`, `src/mcp/server.ts`, `src/server.ts` to deny ANY `*:private:*` scope, not just `slack:private:*`. Cross-source regression tests using a synthetic `acme:private:demo` scope. Ship to npm BEFORE any v1.3 work begins.
- **v1.3.0 (this plan):** GitHub connector built on the generalized filter. Add a startup guard in `src/db.ts` that refuses to run a binary older than v1.2.1 against schema_version >= 24 (prints a remediation message and exits 1).

Task 0 below is the v1.2.1 preflight. Tasks 1-17 are the v1.3 work.

---

## Background reading (do this BEFORE Task 0)

Read these in order. Each links into a downstream task — skipping = drift.

- `docs/plans/2026-04-29-e1.3-slack-ingestion.md` (full file) — the Slack precedent. Every GitHub task mirrors a Slack task. When in doubt, read the Slack equivalent.
- `src/connectors/slack/` — full directory. The shape this plan replicates.
  - `signature.ts` (45 lines): timing-safe HMAC pattern. GitHub differs in algorithm (`X-Hub-Signature-256` is `sha256=<hex>` over raw body; no `v0:ts:body` envelope and no skew check).
  - `scope.ts` (19 lines): default-private safety. GitHub mirrors with `repository.private === false` → public.
  - `tenant-routing.ts` (40 lines): fail-closed multi-tenant rule. GitHub keys on `installation.id`.
  - `ingest.ts` (107 lines): `afterWrite` race-safe idempotency. Re-use the exact pattern.
  - `backfill.ts` (112 lines): cursor + resume-bound. GitHub uses `Link: rel="next"` URL not opaque cursor; resume bound is `since=<ISO>` not numeric ts.
  - `dlq.ts` (301 lines): writeToDlq + listDlq + replayDlqEntry. Re-use shape; bucket names differ (`unroutable`, `parse_error`, `signature_failed`).
- `src/api.ts` — `remember()` surface. `afterWrite` hook is the race-safe idempotency seam.
- `src/raw-archive.ts` — only legitimate way to delete `kind='raw'` rows. Comment-deletion (Task 13) routes through here.
- `src/db.ts` — current schema version 23. Task 1 adds v24.
- `src/server.ts` lines 569-700 — Slack webhook route. Task 14 inserts the parallel GitHub block. PUBLIC_ROUTES set must add the GitHub event path.
- GitHub docs:
  - <https://docs.github.com/en/webhooks/webhook-events-and-payloads> (envelope shape)
  - <https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries> (HMAC algorithm)
  - <https://docs.github.com/en/rest/issues/issues#list-repository-issues> (backfill, `since` param, `Link` pagination)
  - <https://docs.github.com/en/rest/overview/resources-in-the-rest-api#rate-limiting>

---

## Scope mapping reference (used by Tasks 4, 5, 12, 13)

| Source                          | scope                              | artifact_ref                                            |
|---------------------------------|------------------------------------|---------------------------------------------------------|
| Issue (public repo)             | `github:public:<owner>/<repo>`     | `github://<owner>/<repo>/issue/<number>`                |
| Issue (private repo)            | `github:private:<owner>/<repo>`    | `github://<owner>/<repo>/issue/<number>`                |
| Issue comment                   | (inherits repo scope)              | `github://<owner>/<repo>/issue/<n>/comment/<comment_id>`|
| PR                              | (inherits repo scope)              | `github://<owner>/<repo>/pull/<number>`                 |
| PR review comment               | (inherits repo scope)              | `github://<owner>/<repo>/pull/<n>/review_comment/<id>`  |
| `repository.private` undefined  | **`github:private:*`** (fail-safe) | (as above)                                              |

Owner: `user:github:<login>` whenever the event carries `sender.login`.

---

## Task 0: Pre-flight v1.2.1 — generalize `*:private:*` default-deny

**Why:** Codex P0 #1 + #2. Without this, v1.3 ships a privacy leak day one and rollback to v1.2.0 reintroduces it.

**Files:**
- Modify: `src/api.ts` (`passesScopeFilter` and continuity scope filter)
- Modify: `src/cli.ts` (any inlined scope-filter clones — search for `slack:private:`)
- Modify: `src/mcp/server.ts` (memory + snapshot scope filter on `hippo_recall` and `hippo_context`)
- Modify: `src/server.ts` (HTTP `/v1/memories` no-scope branch)
- Create: `tests/scope-filter-generic-private.test.ts`

**Step 1: Write failing tests**

Cover all four entrypoints (api/CLI/HTTP/MCP) plus continuity. For each: write a memory with scope `acme:private:demo`, call recall with no scope, assert the row is filtered out. Repeat with `github:private:owner/repo`. Also: explicit `scope: 'acme:private:demo'` query DOES return it (exact-match wins).

**Step 2:** `npx vitest run tests/scope-filter-generic-private.test.ts` → FAIL (rows currently leak through).

**Step 3: Generalize the filter** in `src/api.ts`:

```ts
const passesScopeFilter = (s: string | null): boolean => {
  if (opts.scope !== undefined && opts.scope !== '') {
    return s === opts.scope;
  }
  if (s === null) return true;
  // Generalized default-deny: ANY `<source>:private:*` is denied for no-scope callers.
  // Was Slack-only in v1.2; v1.2.1 widens to all sources before v1.3 GitHub adds github:private:*.
  if (/^[a-z][a-z0-9_-]*:private:/.test(s)) return false;
  if (s === 'unknown:legacy') return false;
  return true;
};
```

Apply the same shape to:
- continuity scope filter (snapshot + handoff + events)
- `cmdRecall` continuity filter in `src/cli.ts`
- MCP `hippo_recall` and `hippo_context` filters
- HTTP `/v1/memories` no-scope branch

**Step 4: Add startup guard for rollback safety** in `src/db.ts` (next to schema-version read):

```ts
// Refuse to run an older binary against a newer schema. v1.2.1 stamps a
// `min_compatible_binary` meta row when migrating to >= 24; older builds that
// open the same DB will hit this guard and exit cleanly instead of leaking
// private rows that they don't know how to filter.
const minBinaryReq = readMeta(db, 'min_compatible_binary');
if (minBinaryReq && semverGreaterThan(minBinaryReq, PACKAGE_VERSION)) {
  throw new Error(
    `Database requires hippo-memory >= ${minBinaryReq}; this build is ${PACKAGE_VERSION}. Upgrade hippo-memory to open this DB.`,
  );
}
```

The guard row is written by Task 1's migration v24.

**Step 5:** `npx vitest run tests/scope-filter-generic-private.test.ts` → PASS. Full suite green.

**Step 6: Ship as v1.2.1**

```bash
# bump 4 manifests to 1.2.1, CHANGELOG entry "Generalized *:private:* default-deny",
# build, test, commit, npm publish, tag v1.2.1, GitHub Release.
```

Only after v1.2.1 is on npm does Task 1 begin.

---

## Task 1: Schema v24 — github_event_log, github_cursors, github_dlq, github_installations, github_repositories, min_compatible_binary

**Why:** Six durable tables, parallel to slack_*.

- `github_event_log` — idempotency keyed on `(idempotency_key)` (NOT delivery_id alone, see Task 3 P0 #3). Stores SHA-256 of canonical body + event_name to defeat delivery-id replay attacks.
- `github_cursors` — backfill cursors per (tenant, repo) with separate high-water marks per stream (codex P1: issue/issue_comment/pr_review_comment crash safety).
- `github_dlq` — full replay metadata (codex P1 #5).
- `github_installations` — installation → tenant.
- `github_repositories` — repo_full_name → tenant for PAT-mode multi-tenant fail-closed routing (codex P0 #4).
- `min_compatible_binary` row in existing `meta` table — startup guard set by migration so older binaries refuse to open schema 24+ (codex P0 #2 rollback safety).

**Files:**
- Modify: `src/db.ts` — append migration v24.
- Create: `tests/github-schema.test.ts`

**Step 1: Write failing test** with eight cases (codex P1 #1: extend beyond happy path):
- `github_event_log` PK on `idempotency_key`, re-insert throws.
- `github_cursors` composite PK `(tenant_id, repo_full_name)`, collide throws; cursor row has separate `issues_hwm`, `issue_comments_hwm`, `pr_review_comments_hwm` columns.
- `github_dlq` autoincrementing id with required replay columns: `event_name`, `delivery_id`, `signature`, `installation_id`, `repo_full_name`, `retry_count`, `bucket`.
- `github_installations` PK `installation_id`.
- `github_repositories` composite PK `(repo_full_name, tenant_id)`.
- Migration is idempotent: re-running yields no error (drop-and-rebuild not used).
- Migration on a DB with preexisting `github_*` tables from a failed canary: detect column mismatch, abort with actionable error rather than silently CREATE TABLE IF NOT EXISTS over a wrong schema.
- After migration, `meta.min_compatible_binary` is set to `'1.2.1'`.

**Step 2:** `npx vitest run tests/github-schema.test.ts` → FAIL `no such table: github_event_log`.

**Step 3:** Append migration v24 in `src/db.ts` (CURRENT_SCHEMA_VERSION 23 → 24):

```ts
{
  version: 24,
  up: (db) => {
    // Pre-migration compatibility check (codex P1 #1): if any github_* table
    // exists with a column shape we don't recognize, abort with an actionable
    // error rather than CREATE TABLE IF NOT EXISTS-ing over partial state.
    assertNoIncompatibleGithubTables(db);

    db.exec(`CREATE TABLE IF NOT EXISTS github_event_log (
      idempotency_key TEXT PRIMARY KEY,
      delivery_id TEXT NOT NULL,
      event_name TEXT NOT NULL,
      ingested_at TEXT NOT NULL,
      memory_id TEXT
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_github_event_log_memory ON github_event_log(memory_id) WHERE memory_id IS NOT NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_github_event_log_delivery ON github_event_log(delivery_id)`);
    db.exec(`CREATE TABLE IF NOT EXISTS github_cursors (
      tenant_id TEXT NOT NULL,
      repo_full_name TEXT NOT NULL,
      issues_hwm TEXT,
      issue_comments_hwm TEXT,
      pr_review_comments_hwm TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, repo_full_name)
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS github_dlq (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL,
      raw_payload TEXT NOT NULL,
      error TEXT NOT NULL,
      event_name TEXT,
      delivery_id TEXT,
      signature TEXT,
      installation_id TEXT,
      repo_full_name TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      received_at TEXT NOT NULL,
      retried_at TEXT,
      bucket TEXT NOT NULL DEFAULT 'parse_error'
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_github_dlq_tenant_received ON github_dlq(tenant_id, received_at)`);
    db.exec(`CREATE TABLE IF NOT EXISTS github_installations (
      installation_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      added_at TEXT NOT NULL
    )`);
    // PAT-mode multi-tenant routing seam (codex P0 #4). Maps repo full_name
    // to tenant when the webhook envelope has no `installation` field. Empty
    // by default; populated only by deployments running PAT-mode multi-tenant.
    db.exec(`CREATE TABLE IF NOT EXISTS github_repositories (
      repo_full_name TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      added_at TEXT NOT NULL,
      PRIMARY KEY (repo_full_name, tenant_id)
    )`);
    // Rollback-safety guard (codex P0 #2). Older binaries (< 1.2.1) don't know
    // about generic *:private:* default-deny and would leak github:private:*
    // rows. Refuse to open the DB.
    upsertMeta(db, 'min_compatible_binary', '1.2.1');
  },
},
```

**Step 4:** `npx vitest run tests/github-schema.test.ts` → 8 passed.

**Step 5:** Commit `feat(github): schema v24 — idempotency, cursors, DLQ, installations, repos, rollback guard`.

---

## Task 2: GitHub event types

**Why:** Centralise the four event shapes V1 cares about + the envelope. Type guards used by Task 14 for routing.

**Files:**
- Create: `src/connectors/github/types.ts`
- Create: `tests/github-types.test.ts`

**Shape:**

```ts
// types.ts
// Codex P1 #7: `private` MUST be optional. Slack-style fail-safe in scope.ts
// requires an envelope with `private: undefined` to map to private; a strict
// boolean type would reject the payload before scope can fail closed.
export interface GitHubRepository { full_name: string; private?: boolean; owner: { login: string }; name: string; id?: number; }
export interface GitHubSender { login: string; id: number; }
export interface GitHubInstallation { id: number; }
export interface GitHubWebhookEnvelope {
  action?: string;
  repository?: GitHubRepository;
  sender?: GitHubSender;
  installation?: GitHubInstallation;
}
export interface GitHubIssueEvent extends GitHubWebhookEnvelope {
  action: 'opened' | 'edited' | 'closed' | 'reopened' | 'deleted';
  issue: { number: number; title: string; body: string | null; user: GitHubSender; };
}
export interface GitHubIssueCommentEvent extends GitHubWebhookEnvelope {
  action: 'created' | 'edited' | 'deleted';
  issue: { number: number; };
  comment: { id: number; body: string | null; user: GitHubSender; };
}
export interface GitHubPullRequestEvent extends GitHubWebhookEnvelope {
  action: 'opened' | 'edited' | 'closed' | 'reopened' | 'synchronize' | 'ready_for_review';
  pull_request: { number: number; title: string; body: string | null; user: GitHubSender; };
}
export interface GitHubPullRequestReviewCommentEvent extends GitHubWebhookEnvelope {
  action: 'created' | 'edited' | 'deleted';
  pull_request: { number: number; };
  comment: { id: number; body: string | null; user: GitHubSender; };
}

export function isGitHubWebhookEnvelope(x: unknown): x is GitHubWebhookEnvelope { /* duck-type repository */ }
export function isGitHubIssueEvent(x: unknown, evtHeader: string): x is GitHubIssueEvent { return evtHeader === 'issues' && /* ... */; }
// ...one guard per event type, each gated on the X-GitHub-Event header value
```

**Tests (4 cases):** each guard returns true for a fixture, false for a malformed shape, false for the wrong `X-GitHub-Event` header. Real fixtures pulled from <https://docs.github.com/en/webhooks/webhook-events-and-payloads#issues> abbreviated.

**Step 5:** Commit `feat(github): typed envelope and event guards`.

---

## Task 3: HMAC signature verification + replay-resistant idempotency key

**Why:** `X-Hub-Signature-256` is the only auth on the webhook route. Timing-safe compare after format validation. **Codex P0 #3:** GitHub signs the body only (NOT `X-GitHub-Delivery`), so an attacker who captures one signed payload can replay the same body with arbitrary new delivery IDs and bypass `github_event_log`. Idempotency key MUST derive from the signed material plus a stable source-side identifier, not from `X-GitHub-Delivery`.

**Files:**
- Create: `src/connectors/github/signature.ts`
- Create: `tests/github-signature.test.ts`

**Shape:**

```ts
import { createHmac, timingSafeEqual } from 'crypto';

export interface VerifyOpts {
  rawBody: string;
  signature: string; // value of X-Hub-Signature-256, e.g. 'sha256=ab12...'
  webhookSecret: string;
  /** Previous secret for rotation parity with Slack. Optional. */
  previousSecret?: string;
}

function verifyOne(rawBody: string, signature: string, secret: string): boolean {
  if (!signature.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function verifyGitHubSignature(opts: VerifyOpts): boolean {
  if (verifyOne(opts.rawBody, opts.signature, opts.webhookSecret)) return true;
  if (opts.previousSecret && verifyOne(opts.rawBody, opts.signature, opts.previousSecret)) return true;
  return false;
}
```

**Replay protection — idempotency key (codex P0 #3):**

Because GitHub does NOT sign `X-GitHub-Delivery`, deriving idempotency from the delivery ID is unsafe (attacker mints a fresh UUID per replay). Compute a key over signed and source-stable material:

```ts
import { createHash } from 'crypto';

/**
 * Replay-safe idempotency key.
 * Inputs:
 *   - eventName from X-GitHub-Event header (gated by signature: server only
 *     allows known event names through to ingest, so this is effectively
 *     part of the trust surface)
 *   - rawBody (signed by HMAC; tamper-evident)
 *
 * Output: sha256(eventName + ':' + rawBody) hex.
 *
 * Rationale: any valid replay of (eventName, body) is the same event. Adding
 * delivery_id to the key would give an attacker a free dedupe-bypass.
 */
export function computeIdempotencyKey(eventName: string, rawBody: string): string {
  return createHash('sha256').update(`${eventName}:${rawBody}`).digest('hex');
}
```

Stored as `github_event_log.idempotency_key` (PRIMARY KEY). `delivery_id` is kept as audit metadata and indexed for triage, but is NOT the dedupe seam.

**Note vs Slack:** Slack envelope carries `X-Slack-Request-Timestamp` in the signed material so a 5-minute skew check works. GitHub has no equivalent. The idempotency key above is the replay barrier.

**Tests (8 cases):** valid signature passes; wrong secret fails; malformed `sha256=` prefix fails; length-mismatch fails; previous-secret rotation passes; non-hex characters in signature fail; whitespace-padded signature fails; identical body with different `eventName` produces a different idempotency key (the codex P0 #3 replay defense — assert two events with same body but different X-GitHub-Event headers do NOT collide).

**Step 5:** Commit `feat(github): timing-safe HMAC verifier + replay-safe idempotency key`.

---

## Task 4: Scope mapping

**Files:**
- Create: `src/connectors/github/scope.ts` (mirror Slack scope.ts).
- Create: `tests/github-scope.test.ts`

**Shape:**

```ts
import type { GitHubRepository } from './types.js';

export function scopeFromRepository(repo: GitHubRepository | undefined): string {
  if (!repo) return 'github:private:unknown'; // fail-safe: no repo → private
  if (repo.private === false) return `github:public:${repo.full_name}`;
  return `github:private:${repo.full_name}`;
}
```

**Tests (4):** public repo → `github:public:owner/name`; private repo → `github:private:owner/name`; missing repo → `github:private:unknown`; `private: undefined` (legacy payload) → private (fail-safe).

**Step 5:** Commit `feat(github): scope mapping with fail-safe default-private`.

---

## Task 5: Event-to-RememberOpts transform

**Why:** One transform per event type. Returns null for empty bodies (skip but mark seen).

**Files:**
- Create: `src/connectors/github/transform.ts`
- Create: `tests/github-transform.test.ts`

**Shape (one of four):**

```ts
import type { RememberOpts } from '../../api.js';
import { scopeFromRepository } from './scope.js';
import type { GitHubIssueEvent } from './types.js';

export function issueEventToRememberOpts(evt: GitHubIssueEvent): RememberOpts | null {
  const body = evt.issue.body?.trim();
  const text = [evt.issue.title, body].filter(Boolean).join('\n\n');
  if (!text) return null;
  const repoFull = evt.repository?.full_name ?? 'unknown/unknown';
  const artifactRef = `github://${repoFull}/issue/${evt.issue.number}`;
  return {
    content: text,
    kind: 'raw',
    scope: scopeFromRepository(evt.repository),
    artifactRef,
    owner: `user:github:${evt.issue.user.login}`,
    tags: [
      'source:github',
      `repo:${repoFull}`,
      `event:issues.${evt.action}`,
      `user:github:${evt.issue.user.login}`,
    ],
  };
}
// + issueCommentEventToRememberOpts, pullRequestEventToRememberOpts, prReviewCommentEventToRememberOpts
```

**Tests (12 — three per event type):** valid body → opts shape exact match (including artifactRef format); empty body → null; private repo → `github:private:` scope.

**Step 5:** Commit `feat(github): event-to-RememberOpts transforms`.

---

## Task 6: Idempotency log helpers

**Files:** mirror `src/connectors/slack/idempotency.ts`. Renames: `DuplicateIdempotencyError` (NOT `DuplicateDelivery` — the key isn't delivery-id), `hasSeenKey`, `markKeySeen`, `lookupMemoryByKey`. Table = `github_event_log`, key column = `idempotency_key` (PK). Helpers also persist `delivery_id` and `event_name` alongside for audit, but the dedupe predicate is on `idempotency_key` only.

**Step 5:** Commit `feat(github): idempotency helpers keyed on body+event hash`.

---

## Task 7: Tenant routing — fail-closed under PAT mode

**Why:** Codex P0 #4. Multi-tenant fail-closed rule. The Slack precedent treats "table empty" as "single-tenant install, env fallback is safe" and "table non-empty + unknown id" as "fail closed". PAT-mode GitHub webhooks have no `installation.id` at all, so the naive "missing installation == table-empty fallback" is unsafe in a multi-tenant deployment — a foreign repo's webhook would route into `HIPPO_TENANT`.

**Files:**
- Create: `src/connectors/github/tenant-routing.ts`
- Create: `tests/github-tenant-routing.test.ts`

**Resolution rules** (in order):

1. If `installation.id` is present AND `github_installations` has a row → return that tenant.
2. If `installation.id` is present AND `github_installations` non-empty AND no row → return null (unroutable).
3. If `installation.id` is missing AND `github_installations` is empty AND `github_repositories` is empty → single-tenant install, return `HIPPO_TENANT` or `'default'`.
4. If `installation.id` is missing AND `repository.full_name` matches a row in `github_repositories` → return that tenant (PAT-mode multi-tenant).
5. If `installation.id` is missing AND (`github_installations` non-empty OR `github_repositories` non-empty) AND no repo match → return null (fail closed).
6. Escape hatch (rollback only): `GITHUB_ALLOW_UNKNOWN_INSTALLATION_FALLBACK=1` restores `HIPPO_TENANT` fallback in cases 2 and 5.

**Tests (8):** every numbered rule above plus the escape-hatch case plus a regression test asserting that PAT-mode webhook with non-empty `github_installations` returns null (the bug codex caught).

**Step 5:** Commit `feat(github): fail-closed tenant routing including PAT-mode multi-tenant`.

---

## Task 8: Ingest with afterWrite race-safe idempotency

**Files:** `src/connectors/github/ingest.ts`, mirror `slack/ingest.ts`. The `afterWrite` block uses `INSERT OR IGNORE INTO github_event_log (idempotency_key, delivery_id, event_name, ingested_at, memory_id) VALUES (?, ?, ?, ?, ?)` and throws `DuplicateIdempotencyError` on `changes === 0`. Pre-check uses `hasSeenKey(idempotency_key)`.

**Tests (codex P1 #6 — actually exercise the race):**

1. Fresh ingest: status `'ingested'`, log row exists.
2. Duplicate fast path: re-call with same `(eventName, rawBody)`, status `'duplicate'`.
3. Empty-body skip: status `'skipped'`, log row exists with `memory_id=NULL`.
4. **Real two-worker race** (replaces the broken Slack-style pre-insert test):
   - Use a writer-injected barrier: instrument `afterWrite` via a test-only `__beforeAfterWrite` hook that pauses Worker A inside the savepoint.
   - Worker B calls ingest with the same key, completes normally (its INSERT succeeds, its memory row commits).
   - Release Worker A; its `INSERT OR IGNORE` returns 0 changes; `DuplicateIdempotencyError` thrown; SAVEPOINT rolls back; Worker A's memory row is discarded.
   - Assert: exactly one memory row exists for the key, and it's Worker B's. Worker A returns `{status: 'skipped_duplicate', memoryId: <Worker B's id>}`.

The Slack precedent's pre-insert test exercised the FAST path, not the SAVEPOINT race. Don't repeat that mistake.

**Step 5:** Commit `feat(github): ingest with afterWrite race-safe idempotency`.

---

## Task 9: Rate-limit handling

**Why:** GitHub returns 403 for primary rate-limit (with `X-RateLimit-Remaining: 0` + `X-RateLimit-Reset: <epoch>`) and 429 + `Retry-After: <seconds>` for secondary. Backfill must pause and resume, not error.

**Files:**
- Create: `src/connectors/github/ratelimit.ts`
- Create: `tests/github-ratelimit.test.ts`

**Shape:**

```ts
export interface RateLimitInfo { sleepSeconds: number; reason: 'primary' | 'secondary' | 'none'; }

export function parseRateLimit(headers: Record<string, string | undefined>, status: number, now: number = Date.now() / 1000): RateLimitInfo {
  if (status === 429) {
    const retry = Number(headers['retry-after'] ?? '60');
    return { sleepSeconds: Number.isFinite(retry) ? retry : 60, reason: 'secondary' };
  }
  if (status === 403 && Number(headers['x-ratelimit-remaining'] ?? '1') === 0) {
    const reset = Number(headers['x-ratelimit-reset'] ?? '0');
    const diff = reset - now;
    return { sleepSeconds: Math.max(diff, 1), reason: 'primary' };
  }
  return { sleepSeconds: 0, reason: 'none' };
}
```

**Tests (5):** secondary 429 with `Retry-After: 30` → 30s. Primary 403 with reset 60s in future → 60s. Status 200 → none. Missing `Retry-After` → 60s default. Past reset (clock skew) → at least 1s.

**Step 5:** Commit `feat(github): rate-limit parser for primary and secondary`.

---

## Task 10: Octokit-shaped fetcher

**Why:** Backfill needs an injectable HTTP client so tests don't hit GitHub. Real production uses `node:fetch` against `https://api.github.com`. Test harness returns canned `Link`-paginated responses.

**Files:**
- Create: `src/connectors/github/octokit-client.ts`
- Create: `tests/github-octokit-client.test.ts`

**Shape:**

```ts
export interface GitHubBackfillPage {
  items: Array<unknown>; // typed per endpoint by caller
  next: string | null;   // parsed Link rel="next" URL or null
  rateLimit: RateLimitInfo;
}
export type GitHubFetcher = (args: {
  url: string;          // full URL on first call, next-link URL on subsequent
  token: string;
}) => Promise<GitHubBackfillPage>;

export class GitHubFetchError extends Error {
  constructor(readonly status: number, readonly bodyExcerpt: string, readonly url: string) {
    super(`GitHub ${status} on ${url}: ${bodyExcerpt}`);
    this.name = 'GitHubFetchError';
  }
}

export const realGitHubFetcher: GitHubFetcher = async ({ url, token }) => {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  const headers = headersToRecord(res.headers);
  const rateLimit = parseRateLimit(headers, res.status);
  // Codex P1 #4: treating non-200 as "items=[]" turned 401/403/404/500 into
  // silent empty backfills. Throw on any non-200 unless it is a recognized
  // rate-limit (caller pauses + retries that path).
  if (res.status !== 200 && rateLimit.reason === 'none') {
    const body = await res.text().catch(() => '');
    throw new GitHubFetchError(res.status, body.slice(0, 256), url);
  }
  const items = res.status === 200 ? (await res.json()) as Array<unknown> : [];
  const link = res.headers.get('link') ?? '';
  const next = parseNextLink(link);
  return { items, next, rateLimit };
};

export function parseNextLink(linkHeader: string): string | null {
  // Header format: <url1>; rel="next", <url2>; rel="last"
  // Returns url1 or null.
}
```

**Tests (8):** parses `<u>; rel="next"`; ignores `rel="last"`; null on missing rel="next"; multi-rel quoted-comma edge case; empty header returns null; **401 throws `GitHubFetchError`**; **404 throws `GitHubFetchError`**; **500 throws `GitHubFetchError`**.

**Step 5:** Commit `feat(github): octokit-shaped fetcher with Link parsing and non-200 throws`.

---

## Task 11: Backfill with cursor + ratelimit pause

**Files:**
- Create: `src/connectors/github/backfill.ts`
- Create: `tests/github-backfill.test.ts`, `tests/github-backfill-ratelimit.test.ts`, `tests/github-backfill-cursor.test.ts`

**Shape:** mirror `slack/backfill.ts` structurally, but with three independent streams and three independent cursors per repo (codex P1 #3).

**V1 endpoints backfilled (separate streams, separate high-water marks):**

1. **Issues stream:** `GET /repos/{owner}/{repo}/issues?state=all&since=<issues_hwm>`. **Filter out PRs** (`if (item.pull_request) skip`) — codex P1 #2 / open Q2 decision. Advance `issues_hwm` to the max `updated_at` of fetched-and-ingested issues only after the entire pagination chain completes for this stream.
2. **Issue comments stream:** `GET /repos/{owner}/{repo}/issues/comments?since=<issue_comments_hwm>` (the repo-level endpoint, not per-issue — far fewer round trips). Advance `issue_comments_hwm` after stream completion.
3. **PR review comments stream:** `GET /repos/{owner}/{repo}/pulls/comments?since=<pr_review_comments_hwm>`. Advance `pr_review_comments_hwm` after stream completion.

**Cursor crash safety (codex P1 #3):** advance each high-water mark ONLY after the corresponding stream has fully drained without error. A crash mid-stream leaves the HWM at the previous value so the rerun re-fetches everything from the last completed snapshot (idempotency log dedupes the rows that already landed). Per-page advancement is unsafe because `updated_at` ordering inside a single `since=` window is not monotonic across child resources.

**Tests (10):**
- Fresh backfill ingests N items; all three HWMs advance.
- Rerun with same cursors returns 0 new ingests (idempotency).
- PR appears in `/issues` response → skipped (no `issue/N` row written for it).
- Rate-limit 403 mid-page sleeps then resumes; HWM does NOT advance until stream completes.
- Crash injection (throw inside fetcher mid-stream) — HWM does NOT advance; rerun re-fetches full window; final state has exactly N rows (idempotency).
- 401 from fetcher → `GitHubFetchError` propagated, HWMs unchanged.
- Issues stream fully drains, then issue_comments stream throws — issues HWM advances, comments HWM does NOT.
- Three streams interleaving with different HWMs all converge correctly.
- Empty repo → all three HWMs stamp to `now()` to avoid re-scanning history.
- Resuming after partial drain skips already-ingested rows via idempotency.

**Step 5:** Commit `feat(github): paginated backfill with per-stream cursors and crash-safe HWM advancement`.

---

## Task 12: Comment deletion sync — tenant-scoped, archive-all-active

**Why:** GitHub fires `issue_comment.deleted` and `pull_request_review_comment.deleted`. Issues and PRs themselves cannot be deleted via the public API in V1, but **transferred** issues do fire `issues.transferred` — V1 ignores transfers (logs to DLQ as `unhandled`). Comment deletions route to `archiveRawMemory()`.

**Codex P0 #5:** the naive "look up memory by artifact_ref" pattern omits two critical filters:
1. No `tenant_id` filter → could archive a different tenant's memory if scopes ever collide.
2. No `kind='raw'` filter → could archive a distilled memory that happens to share the artifact_ref.

Plus: GitHub edits keep the same artifact_ref, so multiple raw rows can exist (one per edit revision). Deleting "the" memory leaves older private bodies still searchable.

**Files:**
- Create: `src/connectors/github/deletion.ts`
- Create: `tests/github-deletion.test.ts`

**Shape:**

```ts
export function handleCommentDeleted(ctx: Context, input: { artifactRef: string; idempotencyKey: string }): {
  status: 'archived' | 'archive_skipped_not_found' | 'duplicate';
  archivedCount: number;
} {
  const db = openHippoDb(ctx.hippoRoot);
  try {
    if (hasSeenKey(db, input.idempotencyKey)) {
      return { status: 'duplicate', archivedCount: 0 };
    }
    const rows = db.prepare(
      `SELECT id FROM memories
        WHERE artifact_ref = ?
          AND tenant_id = ?
          AND kind = 'raw'
          AND archived_at IS NULL`,
    ).all(input.artifactRef, ctx.tenantId) as Array<{ id: string }>;
    if (rows.length === 0) {
      markKeySeen(db, input.idempotencyKey, null);
      return { status: 'archive_skipped_not_found', archivedCount: 0 };
    }
    for (const r of rows) {
      archiveRawMemory(ctx, r.id, 'github:source_deletion');
    }
    markKeySeen(db, input.idempotencyKey, rows[0]!.id);
    return { status: 'archived', archivedCount: rows.length };
  } finally {
    closeHippoDb(db);
  }
}
```

**Tests (8):**
- Single matching row → archived; row no longer surfaces in recall.
- Multiple raw rows for same artifact_ref (edit history) → ALL archived.
- Cross-tenant safety: row with same artifact_ref under different tenant → NOT archived.
- Cross-kind safety: row with `kind='distilled'` under same artifact_ref → NOT archived.
- Missing memory (out-of-order delivery) → `archive_skipped_not_found`, idempotency seen.
- Duplicate delivery → `duplicate`, no double-archive.
- Already-archived row (re-deletion) → no-op, idempotency seen.
- After archive, no-scope recall does NOT return the previously-private body.

**Step 5:** Commit `feat(github): tenant-scoped, kind-filtered, multi-row comment deletion`.

---

## Task 13: DLQ + replay (with full replay metadata)

**Files:**
- Create: `src/connectors/github/dlq.ts` — mirrors Slack DLQ but with extra columns from Task 1 schema (codex P1 #5).
- Create: `tests/github-dlq.test.ts`

**`writeToDlq` accepts:** `tenantId`, `rawPayload`, `error`, `bucket`, plus replay-required fields `eventName`, `deliveryId`, `signature`, `installationId`, `repoFullName`. Buckets: `parse_error | unroutable | signature_failed | unhandled`.

**Replay flow:** `replayDlqEntry(id)` re-verifies signature using current `GITHUB_WEBHOOK_SECRET`, then dispatches via the same code path as the live webhook route. If signature fails (secret rotated since DLQ entry was written), require `--force` and log a warning. Bumps `retry_count`.

**Tests (8):** write all four bucket types; list filtered by tenant; replay valid entry → re-ingests via live path; replay rotated-secret without force → fails; with force → re-ingests; replay after row already ingested via webhook → idempotent (no double-write); retry_count increments; replay nonexistent id → exit 1.

**Step 5:** Commit `feat(github): DLQ with replay metadata`.

---

## Task 14: Webhook route POST /v1/connectors/github/events

**Why:** The event entrypoint. Verify signature → parse envelope → resolve tenant → dispatch by `X-GitHub-Event` header → ingest → ACK 200. Always ACK 200 on parseable + signed envelopes; DLQ on parse failure with 200; 401 on bad signature; 404 when `GITHUB_WEBHOOK_SECRET` is unset (mirrors Slack pattern).

**Files:**
- Modify: `src/server.ts` — add route block after the Slack one. Add `'POST /v1/connectors/github/events'` to `PUBLIC_ROUTES`.
- Create: `tests/github-webhook-route.test.ts`

**Critical headers handled:**
- `X-Hub-Signature-256` → signature verification (Task 3)
- `X-GitHub-Event` → event type discriminator (`issues`, `issue_comment`, `pull_request`, `pull_request_review_comment`, `ping`); also feeds the idempotency key (Task 3)
- `X-GitHub-Delivery` → audit metadata only (NOT the dedupe key — codex P0 #3)
- `ping` event → ACK 200 with `{pong: true}`, do NOT ingest

**Tests (15):** valid signature + each event type ingests one row with correct scope + artifact_ref (4); bad signature → 401; missing `X-Hub-Signature-256` → 401; missing `GITHUB_WEBHOOK_SECRET` env → 404; ping event → 200 pong; deletion event → archive call (with cross-tenant safety from Task 12); unknown installation in multi-tenant install → DLQ + 200; PAT-mode webhook in multi-tenant install with no repo mapping → DLQ unroutable + 200 (codex P0 #4); parse error → DLQ + 200; **replay attack (same body, fresh `X-GitHub-Delivery` UUID) → ingest treated as duplicate via idempotency_key** (codex P0 #3); unhandled event type → DLQ + 200.

**Step 5:** Commit `feat(github): webhook route POST /v1/connectors/github/events`.

---

## Task 15: CLI — hippo github backfill / dlq list / dlq replay

**Files:**
- Modify: `src/cli.ts` — add `cmdGithub` dispatcher next to `cmdSlack` (line ~5219 in current file).
- Create: `tests/github-cli.test.ts`

**Surface:**
```
hippo github backfill --repo <owner/name> [--since ISO]
hippo github dlq list
hippo github dlq replay <id> [--force]
```

**Token resolution:** `GITHUB_TOKEN` env var. If unset on `backfill`, print actionable error and exit 2 (mirror Slack `SLACK_BOT_TOKEN` check).

**Tests (6):** backfill happy path with mocked fetcher, missing token → exit 2, dlq list empty → "no entries", dlq list with rows → tabular output, replay valid id → re-ingests, replay invalid id → exit 1.

**Step 5:** Commit `feat(github): CLI for backfill, dlq list, dlq replay`.

---

## Task 16: 200-event smoke test

**Why:** Success criterion. End-to-end flow with fixtures: 200 webhook deliveries spanning all four event types + 5 deletions. Strengthened from row-count checks to security-boundary checks (codex P2 #2).

**Asserts:**
- Exactly 195 active `kind='raw'` rows after the stream (200 − 5 deletions; 5 archived rows still in DB but `archived_at IS NOT NULL`).
- Every row has `tags` containing `'source:github'`.
- Public repo events have scope `github:public:<owner>/<repo>`; private start `github:private:`.
- Every row has `owner='user:github:<login>'`.
- Re-running the same 200-event stream produces 0 new ingests (idempotency).
- **No-scope recall denial:** running `recall({query: <text from a private-repo memory>})` with no scope returns 0 rows. Same query with explicit `scope: 'github:private:owner/repo'` returns the row.
- **Replay defense:** replay each of the 200 deliveries with a fresh `X-GitHub-Delivery` UUID but identical body and `X-GitHub-Event` → idempotency rejects all 200 (codex P0 #3).
- **Tenant routing failure:** synthesize a webhook from an `installation.id` not in `github_installations` → DLQ unroutable, no memory created.
- **Cross-scope leak negative test:** insert a synthetic `acme:private:demo` row, run no-scope recall over the GitHub stream — assert the `acme:private:demo` row stays hidden (verifies Task 0 generalized filter).

**Files:**
- Create: `tests/github-smoke-200.test.ts`
- Create: `tests/fixtures/github-events.json` — generated, 200 entries.

**Step 5:** Commit `test(github): 200-event smoke + security-boundary assertions`.

---

## Task 17: Provenance gate parity check

**Why:** The queued provenance CI gate (May 16 remote agent) needs to see GitHub rows. Confirm `hippo provenance --json | jq .rawTotal` rises after smoke ingest.

**Files:**
- Create: `tests/github-provenance-parity.test.ts`

**Test:** ingest 50 GitHub events, run `hippo provenance --json`, assert `rawTotal` >= 50, all `source` values include `'github'`, no rows have `owner=null`.

**Step 5:** Commit `test(github): provenance gate parity`.

---

## Done criteria

- [ ] **v1.2.1 preflight** (Task 0) shipped to npm before any v1.3 work begins.
- [ ] All 17 tasks (0–17) committed individually.
- [ ] `npx vitest run tests/github-*.test.ts` → all green.
- [ ] `npx vitest run tests/scope-filter-generic-private.test.ts` → green (Task 0).
- [ ] `npx vitest run` → full suite green (no regressions in slack-* or core).
- [ ] `npm run build` → tsc clean.
- [ ] `hippo github backfill --repo X/Y` against a real PAT + small public repo produces real raw rows tagged `github:public:X/Y` (manual smoke).
- [ ] Older binary (< v1.2.1) refuses to open a v1.3-migrated DB (manual rollback safety check).
- [ ] CHANGELOG.md and README.md updated for both v1.2.1 and v1.3.0.
- [ ] Plan doc stays in `docs/plans/` with the GSTACK REVIEW REPORT footer documenting the codex round.

---

## Decisions (was: open questions; resolved by codex 2026-05-04)

1. **Signature replay protection.** No timestamp check (GitHub doesn't sign one). Replay defense lives in the idempotency key (`sha256(eventName + ':' + rawBody)`), NOT in `X-GitHub-Delivery`. Task 3.
2. **PR-as-issue duplication.** Skip PRs in the `/issues` backfill endpoint via `if (item.pull_request) skip`. PR bodies are picked up from the `pull_request` webhook + a future PR-specific backfill if V2 needs reach-back. Task 11.
3. **PR review comment vs issue comment.** Keep separate. Different endpoints, different artifact_ref shapes. Merging would lose triage signal. Task 5, Task 11.
4. **Token storage.** V1 = `GITHUB_TOKEN` env var, valid only for single-tenant deployments. Multi-tenant deployments must use per-installation tokens (V2). Document in README that PAT mode + multi-tenant requires populating `github_repositories`. Task 7, Task 15.
5. **Discussion threads.** Deferred to V2. Different API surface, different threading model — risk/reward bad for V1. Add to Non-goals.
6. **Rate-limit policy.** Reactive only (pause on 429/403, retry). No proactive throttling. BUT non-rate-limit non-200 responses MUST throw, not silently empty-page. Task 9, Task 10.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Codex Review | `/codex review` | Independent 2nd opinion on plan | 1 | issues_found | 5 P0, 8 P1, 2 P2 — all consolidated into plan |
| Eng Review | `/plan-eng-review` | Architecture & tests | 0 | not run | — |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | n/a | (no UI in connector) |
| DX Review | `/plan-devex-review` | DX gaps | 0 | not run | — |

**CODEX:** Round 1 (2026-05-04, ~93k tokens, gpt-5.5 high reasoning). Found 5 P0 (scope-filter generalization, rollback exposure, delivery-id replay, PAT-mode tenant routing, deletion filter), 8 P1 (schema validation, PR-as-issue, cursor crash safety, non-200 silent empty, DLQ replay metadata, race test, type contract, open questions), 2 P2 (HMAC wording, smoke strength). All consolidated and patched into this plan on 2026-05-04.

**VERDICT:** Plan revised. Ready for /full-power execution.
