# Design decisions needed — 2026-05-24

Items on `TODOS.md` blocked on Keith's design call. Presented as
options + tradeoffs so a decision can be made without re-deriving the
context. Once decided, each item becomes an episode-sized A-item.

**Source:** TODOS.md (v1.12.0 sub-2 tail, v1.11.4 Episode B follow-ups,
v0.40.0 security-hardening follow-ups). All reproduce-checked against
current `master` (commit `b4ac704`) on 2026-05-24.

**Decision log convention:** mark each item with one of
`DECIDED-A` / `DECIDED-B` / `DECIDED-C` / `DEFERRED` and a one-line
reason. The picked sub-section then becomes the spec for the follow-on
plan doc.

---

## D1 — `/v1/sleep` response shape: cross-tenant counter scoping

**Source:** `TODOS.md` v1.11.4 Episode B follow-ups (first item).

**Problem.** `SleepResult` aggregates counts across ALL tenants in the
hippoRoot: `deduped.crossDups`, `audit.errorsRemoved`, `audit.warningCount`,
`ambient.totalMemories`. v1.12.0 sub-1 admin-gated `POST /v1/sleep` so
the blast radius today is "only admin Bearers can read the aggregate",
but once non-loopback serving lands (see D3), this becomes a
metadata-leak path: an admin in tenant A learns tenant B's deduped
count, audit-error count, total-memory count.

**Verbatim count being leaked** (from
`tests/api-context-sleep-contracts.test.ts:160-180`):
- `removed`, `mergedEpisodic`, `newSemantic` — per-sleep activity
- `deduped.removed`, `.semDups`, `.epiDups`, `.crossDups` — dedup counters
- `audit.errorsRemoved`, `.warningCount` — audit-pipeline counters
- `ambient.totalMemories`, `.avgStrength` — ambient summary
- `shared` — auto-share count

**Options.**

- **(a) Scope-at-source.** Plumb `ctx.tenantId` into `deduplicateStore`,
  `auditMemories`, `computeAmbientState`, and the underlying
  `loadAllEntries`. Each phase computes its counter against only the
  caller's tenant slice. `api.sleep` returns per-tenant `SleepResult`.
  **Cost:** ~6 files (deduplicateStore, auditMemories, the ambient
  computer, plus loadAllEntries call sites). L9-style work. Need new
  tests for cross-tenant non-interference per counter.
  **Side-effect:** dedup quality drops — cross-tenant near-duplicate
  detection (`crossDups`) becomes structurally impossible. The
  v1.12.1 L9 work intentionally kept the host-wide reader sites for
  this exact reason.

- **(b) Redact-on-egress.** Keep host-wide aggregation; in `api.sleep`,
  zero out counters for non-loopback non-self callers OR replace with
  the caller's per-tenant slice computed post-hoc.
  **Cost:** ~2 files (api.ts sleep return path, server.ts response
  serializer). Far smaller scope than (a).
  **Side-effect:** dedup quality preserved; admin loopback retains the
  full picture for ops; non-loopback admin Bearer sees only their own
  tenant slice.

- **(c) Defer indefinitely.** Document the metadata-leak in
  `MEMORY_ENVELOPE.md` and a `SECURITY.md` known-issues section.
  Don't ship non-loopback admin Bearer access until (a) or (b) lands.
  **Cost:** docs only.
  **Side-effect:** blocks any future "remote admin dashboard" path.

**Recommendation.** **(b) redact-on-egress.** Cheaper, preserves dedup
quality, and the loopback admin case (today's actual user) gets
full ops visibility. (a) is the structurally pure answer but the
cross-tenant `crossDups` counter is genuinely useful for a host
operator and (a) deletes that observability.

**Decision:** DECIDED-(b) redact-on-egress (Keith 2026-05-24, shipped v1.12.10). See `src/sleep-redact.ts` + `tests/sleep-redact.test.ts`.

---

## D2 — Consolidate audit row tenant tag

**Source:** `TODOS.md` v1.12.0 sub-2 tail (third item).

**Problem.** `api.sleep` emits one `audit_log` row per invocation
(`op='consolidate'`) tagged with `ctx.tenantId`. But `api.sleep` is
host-wide (cross-tenant dedup is intentional). The mismatch: tenant A's
admin Bearer triggers `/v1/sleep`, gets back per-host counters, but the
audit row says "tenant A consolidated" — misleading audit trail.

**Today's mitigation.** Loopback-only + admin-gated since v1.12.0 sub-1.
Only an admin operator can call. Audit row tagged with operator's tenant
is correct from "who pulled the trigger" angle but wrong from "what
data was touched."

**Options.**

- **(a) Tag with synthetic `'__host__'` tenant.** Audit row records that
  the consolidation was host-wide, regardless of caller. CLI auditor
  filters can scope per-tenant easily and see the `__host__` row as
  separate.
  **Cost:** 1 line in `api.ts:~2086`. Migration to whitelist `__host__`
  in `tenant_id` constraint (currently free-form). Update audit-read
  routes to handle `__host__` filter visibility.
  **Side-effect:** introduces a magic-string tenant. Cleaner than per-phase
  rows.

- **(b) One audit row per tenant touched.** N rows per `api.sleep` call,
  each tagged with the tenant whose memories were affected. Tenant A's
  audit feed shows `consolidate` rows whenever a host sleep ran.
  **Cost:** non-trivial — needs `api.sleep` to track per-tenant phase
  results and emit N rows in the finally block. ~5x audit-log volume on
  the host but tenant-feeds stay clean.
  **Side-effect:** preserves per-tenant audit feed semantics but blows
  up audit volume.

- **(c) Scope `api.sleep` per-tenant entirely (i.e. couple to D1-a).**
  Audit row stays as-is; tenant-scoped consolidation makes the tag
  honest.
  **Cost:** D1-a's full cost; couples this decision to D1.

**Recommendation.** **(a) `__host__` synthetic tenant**, conditional on
D1 = (b) redact-on-egress. The two go together: (b) preserves host-wide
dedup, and `__host__` audit tag honestly records that scope.

**Decision:** DECIDED-(a) `__host__` synthetic tenant (Keith 2026-05-24, shipped v1.12.10). `api.sleep` consolidate row now tags `tenant_id=__host__`; `triggeredByTenant` preserved in metadata for forensics. HTTP `/v1/audit?tenant=__host__` query param added. See `src/api.ts:~2161` + `tests/api-sleep-host-tenant.test.ts`.

---

## D3 — Non-loopback serving: when, how, what's required first

**Source:** Implicit gate for D1, D2, and the tenant-isolation residue
from v1.11.0 (TODOS.md "Tenant-isolation residue" item).

**Problem.** Today `serve()` binds 127.0.0.1 only. `/v1/sleep` is
admin-gated; everything else is Bearer-authed. Production hippo deploys
that need cross-host access (managed inference, hosted dashboard, multi-
project sharing across machines) require non-loopback serving. None
shipped yet. Each blocked-on-design item above gates on this decision.

**What "non-loopback" actually means.** Three sub-decisions:

1. **Binding.** `HIPPO_BIND_ALL=1` env knob → bind `0.0.0.0` (or
   user-supplied iface). Default stays loopback.
2. **Trust boundary on rate-limit key.** Today's per-IP token bucket
   degenerates to "one global bucket" under loopback. Non-loopback needs
   trusted `X-Forwarded-For` parsing.
3. **TLS termination.** Out-of-scope (caddy/nginx/Cloudflare in front).
   Document the assumption.

**Required-firsts (must ship before flipping the bind):**

- D1 decision applied (response-shape leak closed)
- D2 decision applied (audit row tag honest)
- Tenant-isolation residue from v1.11.0 closed (`cli.ts` / `dashboard.ts`
  unscoped reader sites audited; `replaceDetectedConflicts` stale-row
  auto-resolve; `hippo_peers` trust boundary confirmed)
- `validateApiKey` timing on unknown key_id documented (or fixed) —
  TODOS v0.40.0 M7 item
- Audit log retention policy (TODOS v0.40.0 M6 item) — non-loopback
  serving means unbounded audit growth becomes a real problem fast

**Options for sequencing.**

- **(a) "Lock-step": ship every gate, then flip.** Order: D1, D2, residue,
  M6, M7, then `HIPPO_BIND_ALL`. Each is its own A-episode (~6 episodes).
  Estimated 1-2 weeks of focused work.
- **(b) "Pull-through": flip bind FIRST behind a feature flag, then
  close gates as users hit them.** Faster to first-byte for the dashboard
  story, but ships known-leaky surface even if behind a flag.
- **(c) "Defer": never ship non-loopback. Document hippo as a
  single-machine product. Multi-machine = SDK + remote SSH tunnel.**
  Honest answer if the demand isn't there.

**Recommendation.** **(a) lock-step.** The leaks documented above are
real and shipping (b) "behind a flag" historically means "the flag gets
flipped before the gates close." If multi-machine demand is genuine,
1-2 weeks of focused work is cheaper than the alternative incident
postmortem.

**Decision:** DECIDED-(a) lock-step (Keith 2026-05-24). Committed in `docs/process/non-loopback-sequencing.md`. Required-firsts tracked there; non-loopback bind flag does NOT ship until every `[x]` is verified.

---

## D4 — `hippo_peers` cross-project read: intentional or hole?

**Source:** TODOS.md v0.40.0 tenant-isolation residue (c).

**Problem.** `hippo_peers` MCP tool reads the cross-project global store
by design (cross-project knowledge sharing was a v0.27+ product
decision). Once multi-tenancy is real (A5 v2), the question is whether
"cross-project" means "cross-tenant" or "within-tenant cross-project."

**Options.**

- **(a) Tenant-scope `hippo_peers`.** Two operators in the same tenant
  see each other's projects' globals. Tenant-A operator can't see
  tenant-B globals. **Default-safe.**
- **(b) Keep host-wide.** All operators see all globals across all
  tenants. Today's behaviour. Honest about the trust model: a hippo
  install is single-tenant from a trust angle, even if `tenant_id`
  scopes per-row reads elsewhere.
- **(c) Configurable per-install.** `HIPPO_PEERS_SCOPE=tenant|host`.
  Default `tenant`. Operators opting into host see the warning.

**Recommendation.** **(a) tenant-scope.** Matches every other read
path's default. Operators who actually want cross-tenant peer discovery
are a) rare, b) capable of using direct SQL.

**Decision:** DECIDED-(a) tenant-scope (Keith 2026-05-24, shipped v1.12.10). `listPeers(globalRoot, tenantId?)` filters when tenantId provided. MCP `hippo_peers` now passes ctx.tenantId; dashboard passes its tenantId; CLI defaults to tenant-scope with `--all-tenants` flag for legacy host-wide. See `src/shared.ts:306` + `tests/shared-listpeers-tenant.test.ts`.

---

## D5 — 24h soak harness: real release gate or scaffold-only?

**Source:** TODOS.md v0.40.0 second-to-last item.

**Problem.** `benchmarks/a1/soak.ts` is scaffold-only in v0.39. Roadmap
mentions "soak-tested" without it being actually wired.

**Options.**

- **(a) Promote to CI gate.** Cron-style nightly soak run on a hippo-CI
  runner. Drift bounds (RSS, heap, FD, WAL) enforced. Pass/fail gates
  the next release.
  **Cost:** CI infra (~1 episode + ops setup). Recurring resource cost
  on whatever runs the cron.
- **(b) Spot-run on minor/major releases only.** Patch releases skip;
  every minor or major release runs a manual local 24h soak before
  publish. Documented in release checklist.
  **Cost:** zero infra; 24h calendar delay per minor.
- **(c) Drop "soak-tested" language from roadmap until (a) ships.**
  Honest about what's actually verified.

**Recommendation.** **(c) for now, (b) when 1.x→2.x is on the horizon.**
v1.12.x patches don't need a soak. (a) is a real ops cost for no
current pain.

**Decision:** DECIDED-(c) for now (Keith 2026-05-24, shipped v1.12.10). Grep of `docs/`/`ROADMAP*.md`/`README.md` confirmed no active doc currently claims `soak-tested` — historical `docs/plans/` files correctly call it `scaffold only`. Lock-step doc commits the recommitment if 1.x→2.x lands without (a) shipping.

---

## Items NOT in this doc (already decided / already shipped)

For reproduce-check completeness — these were on my mental "blocked"
list but turned out to be already resolved:

- ~~`api.recall` last-retrieval-ids parity with `cmdRecall`~~ — DONE-by-design
  v1.11.5 (option b, divergence documented in 3 places). Reproduce-checked
  2026-05-24.
- ~~`audit_log` emission on sleep consolidation phases~~ — DONE-by-design
  v1.11.5 (option a, one row per invocation). v1.12.2 added DI-seam tests
  for `partial:true`. Reproduce-checked 2026-05-24.
- ~~Snapshot tests for `printContextMarkdown` / `renderSleepResult`~~ —
  DONE-by-design v1.11.5. 12 cases shipped. Reproduce-checked 2026-05-24.
- ~~L9 background pipelines tenant scoping~~ — SHIPPED v1.12.1 (PR #41).
- ~~`hippo auth create --role` CLI~~ — SHIPPED v1.12.3 (PR #43).
- ~~`auth_create` audit emit~~ — SHIPPED v1.12.4 (PR #44).
- ~~`hippo slack dlq replay`~~ — SHIPPED (cli.ts:5118, called `replay` not
  `retry` as TODOS-listed). Reproduce-checked 2026-05-24.

The actionable backlog after 6 reproduce-check WINs is what's above.
