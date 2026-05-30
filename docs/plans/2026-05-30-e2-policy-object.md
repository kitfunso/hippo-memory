# Plan: E2 first-class `policy` object (bi-temporal-first)

- Date: 2026-05-30
- Episode: 01KSW4XHBGTKT7HAJ37TBS1W79 (/dev-framework-rl, project_type=backend)
- Status: Draft (not yet engineering-reviewed)

## Goal

Promote `policy` to a first-class E2 object (after decision/prediction/incident/
process), mirroring `src/processes.ts` structurally. ROADMAP-RESEARCH specs it as
the **"bi-temporal-first object type"**. A policy is a named rule/statement that
is in force over an EFFECTIVE-TIME range and evolves via supersession.

## Key design: bi-temporal = first-class valid-time + the supersede chain's transaction-time

Two time axes:
- **Valid time (effective time)** — when the policy is in force in the real world:
  first-class columns `valid_from` (required; defaults to creation time) and
  `valid_to` (nullable = open-ended). This is the "first-class" axis: it is
  queryable via a dedicated as-of query.
- **Transaction time (system time)** — when the row was recorded / retired:
  `created_at` + the supersede chain's `superseded_at`. Present but NOT
  time-travel-queryable in v1 (deferred; see Out of scope).

The supersede/delta lifecycle is the process/decision machinery verbatim
(`superseded_by` self-FK + CAS + INSERT-preflight + server-derived `version` +
`change_summary` + supersede tenant-match trigger). We DROP process's `steps`
(policy has `policy_text`, not an ordered step list) and ADD `valid_from`/
`valid_to` + the as-of query.

Lifecycle: `active` -> `superseded` (a newer version replaces it) or `active` ->
`closed` (retired). Superseding leaves the predecessor's valid-time range intact
(it WAS effective then); only the transaction status flips.

## The as-of query (the bi-temporal-first deliverable)

`loadPoliciesAsOf(hippoRoot, tenantId, asOfDate, name?)`: the **active** policies
in force at a given valid-time:

```sql
SELECT ... FROM policies
WHERE tenant_id = ? AND status = 'active'
  AND valid_from <= ?
  AND (valid_to IS NULL OR ? < valid_to)
  [AND policy_name = ?]
ORDER BY valid_from DESC, id DESC
```

(All operands normalized to fixed-width `toISOString` first, so lexical compare is
correct.) **Codex review correction (round 1, P2):** the query is successor-aware,
not a bare `status='active'` filter. A row is returned when it covers T AND it is
the live answer for T: an `active` row, OR a `superseded` row whose successor was
not yet effective at T (`successor.valid_from > asOf`) - so a Jan-Jun policy
superseded in May is still returned by `asof March`. `closed` rows are excluded.
**Round 2 (P2):** `valid_from` stays the honest creation instant (NOT backdated to
midnight - backdating would make an earlier-same-day as-of wrongly report the
policy in force and hide a superseded predecessor). The common `create then asof
<today>` workflow is fixed on the READ side: a date-only `asof` (no time component)
resolves to END-of-day (23:59:59.999Z) so it includes a policy effective at any
instant that day, while a precise datetime as-of is used exactly. "What we BELIEVED
was in force as of a past transaction-time" (full transaction-time travel, incl.
resurrecting closed policies) remains deferred.

## Validation + date normalization (plan-eng-critic round-1 CRIT/HIGH fix)

THE bug the critic caught: `valid_from` defaulting to `new Date().toISOString()`
is a full datetime (`2026-05-30T14:23:00.000Z`), but a caller can pass a date-only
`asOfDate` (`2026-05-30`). A naive lexical compare makes a policy created today
INVISIBLE to an as-of query for today (a shorter prefix sorts before the longer
datetime). Fix: **normalize every date input to one canonical ISO-8601 datetime at
the store boundary before any compare or persist.**

- `normalizePolicyDate(input: string): string` — `const d = new Date(input);
  if (Number.isNaN(d.getTime())) throw new Error('policy: invalid date "<input>"
  (expected ISO-8601)'); return d.toISOString();`. This (a) validates the string
  is a parseable date (rejects `2026-1-1` malformed? — note: `new Date('2026-1-1')`
  IS accepted by JS and normalized to `2026-01-01T00:00:00.000Z`, which is the
  CORRECT canonical form, so normalization SUBSUMES zero-pad validation: whatever
  parses becomes canonical; whatever doesn't, throws) and (b) collapses date-only
  and datetime to the same canonical full-datetime form so lexical compare is
  always correct.
- ALL FOUR paths route through it: `savePolicy` default (`now` is already
  `toISOString()`, canonical) + `validFrom`/`validTo` inputs + `loadPoliciesAsOf`'s
  `asOfDate` arg. CLI and HTTP pass raw strings to the store fns, which normalize;
  HTTP catches the throw -> 400, CLI -> exit 1.
- `valid_from` required; defaults to `now` (canonical) when omitted (schema NOT NULL).
- `valid_to` optional; when set, after normalization MUST be strictly greater than
  the normalized `valid_from`. Reject inverted/equal ranges at the store (throw ->
  HTTP 400). `validatePolicyDates(validFrom, validTo)` does the compare AFTER both
  are normalized.
- Non-overlap of valid-ranges across versions of the same name is NOT enforced in
  v1 (allowed + documented; the as-of query returns ALL matching active rows -
  `loadPoliciesAsOf` returns an ARRAY at every layer: store, SDK `policies_asof`,
  HTTP `/asof`; no caller treats it as single).
- DoS caps: `policy_name` / `policy_text` / `change_summary` 4096 (mirror the
  process route caps). Dates are normalized (bounded by `toISOString()` to 24
  chars) so no separate length cap is needed; an over-long junk string fails the
  `new Date()` parse.

## Schema (migration v33)

`CURRENT_SCHEMA_VERSION` 32 -> 33. New `policies` table = the v32 processes table
minus `steps`, plus `valid_from`/`valid_to`:

- `id` INTEGER PK AUTOINCREMENT
- `memory_id` TEXT, FK -> memories(id) ON DELETE SET NULL
- `tenant_id` TEXT NOT NULL
- `policy_name` TEXT NOT NULL
- `policy_text` TEXT NOT NULL
- `valid_from` TEXT NOT NULL
- `valid_to` TEXT
- `version` INTEGER NOT NULL DEFAULT 1
- `status` TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','closed'))
- `superseded_by` INTEGER, FK -> policies(id) ON DELETE SET NULL
- `superseded_at` TEXT
- `change_summary` TEXT
- `closed_at` TEXT
- `created_at` TEXT NOT NULL

Indexes: `idx_policies_tenant_status` (tenant_id, status), `idx_policies_memory`
(memory_id WHERE NOT NULL), `idx_policies_asof` (tenant_id, valid_from) for the
as-of query. Triggers (verbatim mirror, renamed): tenant-match INSERT + UPDATE
(vs the referenced memory) + supersede tenant-match UPDATE (self-FK).

## Module `src/policies.ts` (mirror processes.ts)

Exports: `PolicyStatus`, `VALID_POLICY_STATES`, `Policy` (incl `policyText`,
`validFrom`, `validTo: string|null`, `version`, `changeSummary`, `supersededBy`),
`SavePolicyOpts` (`policyName`, `policyText`, `validFrom?`, `validTo?`,
`changeSummary?`, `supersedesPolicyId?`, `extraTags?`), `ListPoliciesOpts`,
`savePolicy`, `closePolicy`, `loadPolicyById`, `loadPolicies`,
`loadActivePolicies`, `loadPoliciesAsOf`, `normalizePolicyDate` (parse+canonicalize,
throws on unparseable), `validatePolicyDates` (normalizes both then enforces
valid_to > valid_from). loadPoliciesAsOf normalizes asOfDate first, then runs the
half-open query.

- `savePolicy`: memory mirror (tags `['policy', ...extra]`, source 'policy',
  confidence 'verified', layer Semantic, half_life `POLICY_HALF_LIFE_DAYS`) +
  policies row inside the writeEntry SAVEPOINT. `valid_from` defaults to `now`;
  `validatePolicyDates` enforces `valid_to > valid_from`. Supersede preflight
  (status='active' + read version), CAS `id != newId`, server-derived version,
  `change_summary`. Emits `policy_create` (+ `policy_supersede`).
- `closePolicy(id)`: CAS active-only; `policy_close`.
- `loadPoliciesAsOf`: the as-of SQL above.
- `POLICY_HALF_LIFE_DAYS = 90` in src/memory.ts.
- Memory mirror content = `policy_name` + `policy_text` + the effective range.

## 3-site audit lockstep

`policy_create`, `policy_supersede`, `policy_close` in audit.ts AuditOp union +
cli.ts VALID_AUDIT_OPS + server.ts VALID_AUDIT_OPS. Pinned by
`tests/audit-ops-policy-lockstep.test.ts`.

## CLI / HTTP / SDK (mirror processes; NO repeatable flags - per the parseArgs learn-delta, N/A here)

- CLI `cmdPolicy`: `new "<name>" --text "<rule>" [--from <iso>] [--to <iso>]` /
  `list [--status]` / `get <id>` / `supersede <id> --text "<rule>" [--from] [--to]
  [--change]` / `close <id>` / `asof <date> [--name <n>]`. Strict
  `parsePositivePolicyId` (`/^\d+$/`). All flags single-value.
- HTTP `/v1/policies`: POST (new), GET (list+status), GET `/v1/policies/asof`
  (date + optional name; placed BEFORE the `/:id` GET), GET `/v1/policies/:id`,
  POST `/v1/policies/:id/supersede`, POST `/v1/policies/:id/close`. DoS caps; 400
  on inverted dates; 404/409 mapping.
- Python SDK: `Policy` model + `new_policy`/`supersede_policy`/`close_policy`/
  `list_policies`/`get_policy`/`policies_asof` (async + sync); `__init__` + both
  `__all__` lists (models.py AND __init__.py - per the codex P3 from the process
  episode).

## Tests (real DB, no mocks)

- `tests/policies-store.test.ts`: dual-write SAVEPOINT atomicity; supersede CAS +
  version chain + self-supersede preflight; close guard (active-only;
  cannot-close-superseded); not-found vs wrong-state; cross-tenant triggers
  (memory + supersede); ON DELETE SET NULL + old-version-loadable; status filters;
  date validation (inverted valid_to rejected; malformed date rejected;
  valid_from defaults to now; **date-only input normalized to canonical datetime**);
  **as-of query** (in-force at a date; open-ended valid_to; name filter; excludes
  not-yet-effective + expired + superseded; half-open boundary: date == valid_to
  NOT in force, == valid_from IS); **CRIT regression test: a policy created with the
  DEFAULT valid_from (now) IS returned by loadPoliciesAsOf for the current datetime,
  AND a date-only as-of for the same calendar day resolves correctly post-
  normalization**; loadActivePolicies.
- `tests/http-policies.test.ts`: 6 routes incl `/asof`, auth gate, status
  validation, cross-tenant isolation, DoS cap, inverted-date 400.
- `tests/audit-ops-policy-lockstep.test.ts`: 3 ops in the 3 sites.
- `tests/policy-cli.test.ts`: `policy new <name>` arg-shift (codex P2 class);
  malformed-id rejected on close/supersede; new->supersede version chain; asof.
- `python/tests/test_policies.py`: Pydantic round-trip + SDK method presence
  (async + sync) + models.__all__ contains Policy.
- **Schema-version bump**: 20 assertion sites 32 -> 33 (grep-verified exactly 20
  via getCurrentSchemaVersion/getSchemaVersion/getMeta schema_version; same 9 files
  as the process episode). EXCLUDE non-schema `toBe(32)`: `physics.test.ts:43`
  `vecDot(...).toBe(32)` (dot product) and the sequential-learning trap 31s. The
  binary-mode bump script targets only the 9 named files, so physics.test.ts is
  never touched; grep-confirm zero schema `.toBe(32)`/`'32'` remain after.

## Steps (each verify-checked)

1. db.ts: CURRENT_SCHEMA_VERSION 32->33 + v33 policies migration. verify: fresh store opens at 33.
2. src/memory.ts POLICY_HALF_LIFE_DAYS=90; src/policies.ts module. verify: tsc.
3. audit.ts/cli.ts/server.ts: 3 ops lockstep. verify: lockstep test.
4. CLI cmdPolicy + dispatch + help. verify: smoke.
5. HTTP /v1/policies routes (incl /asof). verify: http-policies test.
6. Python SDK Policy + 6 methods + both __all__ lists. verify: pytest.
7. CHANGELOG Unreleased entry (em-dash-free).
8. 20 schema-version assertions 32->33; grep-confirm zero schema .toBe(32) remain.
9. Full build + vitest + pytest green.

## Risks & mitigations

- Bi-temporal scope creep: v1 is valid-time-first + as-of; transaction-time travel
  explicitly deferred. Don't build a history table.
- Date validation: string-compare ISO-8601 (sorts lexically); reject valid_to <=
  valid_from; valid_from defaults to now. Tested both layers.
- as-of correctness: half-open interval [valid_from, valid_to); test boundary
  (a date == valid_to is NOT in force; == valid_from IS).
- Self-supersede / dual-write: process preflight + CAS pattern verbatim.
- models.__all__ AND __init__.__all__ both updated (codex P3 from process episode).
- Schema-version drift: 20 sites enumerated; grep-confirm post-bump.
- Line endings: targeted Edits (repo uniformly LF).
- Ships via merge; CHANGELOG Unreleased; NO publish.

## Out of scope (noted)

- Transaction-time travel ("what did we believe was in force as of past system
  time T"): future. v1 as-of is valid-time only, over the active set.
- Non-overlap enforcement across same-name versions: future (v1 allows + documents).
- Recurring/periodic effective windows: future.
