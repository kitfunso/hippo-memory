# api.ts Refactor: Extract getContext() + sleep() + outcomeForLastRecall() (Episode A of 3)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add 3 pure-function exports to `src/api.ts` — `getContext()`, `sleep()`, and `outcomeForLastRecall()` — extracted from heavyweight inline implementations in `src/cli.ts`. Refactor the CLI commands to be thin presentation wrappers over the new api. **CLI output is byte-identical**, no new HTTP routes, no Python. v1.11.3 PATCH bump for the additive `src/api.ts` exports (plus one intentional behavior fix in `cmdOutcome` — see Task 6 + Task 7 CHANGELOG).

**Architecture:** `api.ts` is hippo's pure-function layer (no console.log, no process.exit, no log-file tee). Each new export takes `(ctx, opts)`, returns a structured result, and lets callers handle presentation. CLI keeps its current flag parsing → builds opts → calls the new api → renders the result via dedicated render helpers (extracted to `src/cli-render.ts` or kept inline in cli.ts).

**Tech Stack:** TypeScript existing toolchain. No new dependencies. vitest for new api-level unit tests against the real SQLite store (per project rule).

**Why this episode exists:** The plan-eng-critic of the bundled Python-SDK-v0.1 episode `01KSAJBMHV7F9VSJCR3YNHKBFD` flagged that `api.getContext()` and `api.sleep()` don't exist and that extracting them is itself a substantial refactor — too big to bundle with HTTP-route additions + a new Python SDK in one episode. Episode A is the foundation that lets Episode B (HTTP routes) and Episode C (Python SDK) be small.

**Naming note (MED from plan-eng-critic):** The extracted function is named `getContext` (not `context`) to avoid an ergonomic collision with the existing `Context` interface (`src/api.ts:58`) and the ubiquitous `ctx: Context` parameter convention. Follows the existing `getEntry` / `getEntries` pattern.

---

## Research notes (completed in discover)

- `cmdSleepCore` at `src/cli.ts:2193-2288` (~95 lines, plus the 50-line log-tee wrapper at 2142-2191). Phases: auto-learn-from-git → learn-from-MEMORY.md → consolidate() → dedup → audit (delete junk) → auto-share → ambient-summary. ~6 console.log groups for presentation.
- `cmdContext` at `src/cli.ts:3344-3659` (~315 lines), plus the `printContextMarkdown` helper at `3661-3694` (~33 lines). Flag-driven: `--pinned-only` (UserPromptSubmit hot path), `--auto` (autoDetectContext from git — already lives at 3696-3728 as a separate helper, called by cmdContext), explicit args query, `--budget` (default 1500), `--limit`, `--include-recent`, `--scope`, `--framing` (observe|suggest|assert), `--format` (markdown|json|additional-context). Loads local + global entries (tenant-scoped per v1.11.1), pulls active task snapshot + handoff + recent session events, scores, budgets, renders. Pinned-only path is a separate code branch. **Do NOT read past line 3694** — lines 3696-3728 are `autoDetectContext` (already-extracted helper) and 3734+ is `cmdEmbed` (unrelated).
- `cmdOutcome` at `src/cli.ts:2686-2720` (~35 lines). Bypasses existing `api.outcome` — does its own `loadIndex` + iteration. **Behavior bug:** current `cmdOutcome` does NOT call `appendAuditEvent`; the MCP outcome path (via `api.outcome`) does. T6 fixes this asymmetry. See Task 6 + Task 7 CHANGELOG for the parity framing.
- `api.outcome(ctx, ids, good): {applied}` already exists (api.ts:1044) — emits one `appendAuditEvent` per affected id via `readEntry → applyOutcome → writeEntry → appendAuditEvent`. Stays unchanged.
- Tenant scoping (v1.11.1 lesson): every new `loadAllEntries` / `readEntry` / store call MUST pass `ctx.tenantId`. Audit any extracted helpers for this. Zero `resolveTenantId({})` calls inside the new `api.getContext` or `api.sleep` bodies.

---

## Task 1: Branch

`git checkout -b refactor/api-context-sleep-outcome` from master tip `a86490a`. Confirm clean tree.

---

## Task 2: Define api.ts contracts (types + stubs)

**Files:** Modify `src/api.ts`, create `tests/api-context-sleep-contracts.test.ts`.

**Step 1: Write failing contract test** (type-level only):

```typescript
import { describe, it, expectTypeOf } from 'vitest';
import type { ContextOpts, ContextResult, SleepOpts, SleepResult } from '../src/api.js';
import { getContext, sleep, outcomeForLastRecall } from '../src/api.js';

describe('api contract types', () => {
  it('getContext signature exists', () => { expectTypeOf(getContext).toBeFunction(); });
  it('sleep signature exists', () => { expectTypeOf(sleep).toBeFunction(); });
  it('outcomeForLastRecall signature exists', () => { expectTypeOf(outcomeForLastRecall).toBeFunction(); });
});
```

**Step 2: Implement type definitions + function stubs that throw:**

```typescript
export interface ContextOpts {
  q?: string;
  auto?: boolean;
  budget?: number;             // default 1500
  limit?: number;
  pinnedOnly?: boolean;
  framing?: 'observe' | 'suggest' | 'assert';
  format?: 'markdown' | 'json' | 'additional-context';
  scope?: string;
  includeRecent?: number;
}

export interface ContextResultEntry {
  entry: MemoryEntry;
  score: number;
  tokens: number;
  isGlobal?: boolean;
  isFreshTail?: boolean;
}

export interface ContextResult {
  entries: ContextResultEntry[];
  tokens: number;
  format: 'markdown' | 'json' | 'additional-context';
  activeSnapshot?: TaskSnapshot | null;
  sessionHandoff?: SessionHandoff | null;
  recentEvents?: SessionEvent[];
  rendered?: string; // markdown/additional-context formats; absent for json
}

export interface SleepOpts {
  dryRun?: boolean;
  noLearn?: boolean;
  noShare?: boolean;
}

export interface SleepResult {
  active: number;
  removed: number;
  mergedEpisodic: number;
  newSemantic: number;
  dryRun: boolean;
  autoLearned?: { fromGit: number; fromMemoryMd: number };
  deduped?: { removed: number; semDups: number; epiDups: number; crossDups: number };
  audit?: { errorsRemoved: number; warningCount: number };
  shared?: number;
  ambient?: AmbientState | null;
  details?: string[];
}

// Stubs — real impl in Tasks 3, 4, 5.
export async function getContext(_ctx: Context, _opts: ContextOpts = {}): Promise<ContextResult> {
  throw new Error('getContext() not yet implemented');
}
export async function sleep(_ctx: Context, _opts: SleepOpts = {}): Promise<SleepResult> {
  throw new Error('sleep() not yet implemented');
}
export function outcomeForLastRecall(_ctx: Context, _good: boolean): { applied: number; ids: string[] } {
  throw new Error('outcomeForLastRecall() not yet implemented');
}
```

**Step 3:** `npx tsc --noEmit` clean. Contract test passes (type-level only).

**Step 4: Commit** `feat(api): add ContextOpts/Result + SleepOpts/Result types + function stubs`.

---

## Task 3: Implement `outcomeForLastRecall()`

**Files:** Modify `src/api.ts` (replace stub) + `tests/api-outcome-for-last-recall.test.ts` (new).

**Step 1:** Failing real-DB tests covering: no last-recall returns `{applied:0, ids:[]}`; 3 ids in last-recall applies to all; cross-tenant id silently skipped (matches existing api.outcome behavior — see comment in implementation).

**Step 2:** Implement:

```typescript
export function outcomeForLastRecall(
  ctx: Context, good: boolean,
): { applied: number; ids: string[] } {
  // loadIndex is per-hippoRoot (not tenant-scoped) — last_retrieval_ids is local-only state.
  // Tenant filtering happens inside outcome() via readEntry(..., ctx.tenantId), which
  // silently skips cross-tenant ids. Do NOT tighten loadIndex with tenantId here —
  // doing so would break the (correct) cross-tenant-silent-skip behavior the test covers.
  const idx = loadIndex(ctx.hippoRoot);
  const ids = idx.last_retrieval_ids ?? [];
  if (ids.length === 0) return { applied: 0, ids: [] };
  const { applied } = outcome(ctx, ids, good);
  return { applied, ids };
}
```

Locate the actual `loadIndex` import path during execute (likely `./index-io.js` or `./store.js`); the source-read in execute will confirm.

**Step 3: Commit** `feat(api): outcomeForLastRecall — last-recall wrapper around outcome()`.

---

## Task 4: Implement `sleep()` (extract from cmdSleepCore — narrowed per option-B factoring)

**Files:** Modify `src/api.ts` (replace stub + narrow SleepOpts/SleepResult) + `tests/api-sleep.test.ts` (new) + `src/cli.ts` cmdSleepCore (rewire to call api.sleep + render) + `src/dedupe.ts` (new, extracted from cli.ts) + `tests/api-context-sleep-contracts.test.ts` (T2 contract test, minor update for the narrowed types).

**Scope correction (caught at execute, 2026-05-23):** the plan-eng-critic's "verbatim port" assumption missed that 3 helpers used by cmdSleepCore are cli-private and host-bound:
- `learnFromRepo` (cli.ts:3830) uses `process.cwd()` — intrinsically CLI-bound
- `learnFromMemoryMd` (cli.ts:1963) uses `os.homedir()` — intrinsically CLI-bound
- `deduplicateStore` (cli.ts:2040) is pure (hippoRoot-only) — moveable

The structurally correct factoring: **api.sleep covers only the pure-storage phases** (consolidate + dedup + audit + share + ambient). The auto-learn phases stay in `cmdSleepCore` as CLI-pre-api work. HTTP `/v1/sleep` in Episode B doesn't need auto-learn — the server has no business cwd or client home dir to scan. `deduplicateStore` moves to its own module (`src/dedupe.ts`) so both cli.ts and api.ts can import it.

This narrows `SleepOpts` (drops `noLearn`) and `SleepResult` (drops `autoLearned`). T2's already-committed types are amended.

**Boundary discipline (required):** `cmdSleep` wrapper (`cli.ts:2142-2191`) STAYS UNTOUCHED. The log-file tee, `process.exit`, and `[hippo] sleep complete` console lines stay in CLI. `api.sleep` is pure: no console.log, no process.exit, no log-file IO. The prior bundled episode's CRIT finding (sleep HTTP route bypassing CLI side effects) is prevented by keeping all presentation/side-effects + auto-learn in cli.ts.

**Step 1: Failing tests** (real-DB):
- `dryRun returns counts, no writes` — verify SleepResult.dryRun=true, no audit/dedup/share runs.
- `non-dry-run runs full pipeline; returns populated SleepResult` — verify each phase's counters populate (deduped, audit, shared, ambient).
- `noShare skips auto-share` — SleepResult.shared is undefined.

**Step 2:** Port cmdSleepCore's pure-storage phases (Phase 2-6 of the current implementation) to api.sleep, swapping console.log → result-object population:

- Phase 1: `await consolidate(ctx.hippoRoot, {dryRun: opts.dryRun})` → populate active/removed/mergedEpisodic/newSemantic/details.
- Phase 2 (gated on !dryRun): `deduplicateStore(ctx.hippoRoot)` (from new src/dedupe.ts) → result.deduped {removed, semDups, epiDups, crossDups}.
- Phase 3 (gated on !dryRun): `auditMemories(loadAllEntries(...))` → for error issues, deleteEntry each; result.audit {errorsRemoved, warningCount}.
- Phase 4 (gated on !dryRun && !opts.noShare && config.autoShareOnSleep): `autoShare(ctx.hippoRoot, {minScore: 0.6})` → result.shared.
- Phase 5 (gated on !dryRun && config.ambient.enabled): `computeAmbientState(loadAllEntries(...).filter(!superseded_by))` → result.ambient.

NOT in api.sleep: the auto-learn phase (learnFromRepo + learnFromMemoryMd). Stays in `cmdSleepCore` as CLI-pre-api work.

**Step 3:** Rewire `cmdSleepCore` to: (a) keep the existing auto-learn block before calling api, (b) build `api.Context` + `SleepOpts {dryRun, noShare}`, (c) `await api.sleep(ctx, opts)`, (d) pass the result to a new local `renderSleepResult(result)` function that produces byte-identical console output for Phase 2-6 lines. The auto-learn console lines ("Auto-learned N lessons...", "Imported N memories...") stay as-is in the CLI block. The render function lives in cli.ts (or src/cli-render.ts if it grows past ~60 lines).

**Step 4:** Move `deduplicateStore` + `DedupPair` interface from cli.ts to new `src/dedupe.ts`. Update `cmdDedup` (cli.ts:2090) to import from the new module. Function signature and behavior unchanged.

**Step 5:** Run full suite. Existing CLI tests pass byte-identically (compare output snapshots if any exist). New api.sleep tests pass. Manual smoke: `hippo sleep --dry-run` and `hippo sleep` output identical to master.

**Step 6: Commits** (3 commits for clarity):
- `refactor(dedup): extract deduplicateStore to src/dedupe.ts (prep for api.sleep)` — pure move, no behavior change.
- `refactor(api): narrow SleepOpts/SleepResult per option-B factoring` — drops noLearn/autoLearned (CLI-only concerns).
- `feat(api): extract sleep() from cmdSleepCore (consolidate+dedup+audit+share+ambient)` — main extraction + renderSleepResult + cmdSleepCore rewire + tests.

---

## Task 5: Implement `getContext()` (extract from cmdContext)

**Files:** Modify `src/api.ts` (replace stub) + `tests/api-context.test.ts` (new) + `src/cli.ts` cmdContext (rewire) + `tests/cli-context-render-snapshot.test.ts` (new — see Step 1b).

**Step 1: Failing api-level tests** (real-DB) — exercise the structured result:
- Default budget returns strongest memories.
- Explicit `q` filters results.
- `pinnedOnly` path returns only pinned entries.
- `auto` triggers autoDetectContext (mock git diff via the existing test fixtures if needed).
- Framing observe/suggest/assert each produces correct prefix in rendered string.
- Tenant scoping: tenant_a session does not see tenant_b memories. Mandatory per v1.11.1 lessons.
- activeSnapshot/sessionHandoff/recentEvents populated when present in the store.
- format=json returns entries with no rendered string.
- format=markdown returns rendered string.
- format=additional-context returns the Claude-Code-shaped envelope.

**Step 1b: Failing CLI-level render snapshot tests** (new file `tests/cli-context-render-snapshot.test.ts`) — these guarantee the "CLI byte-identical" claim. Per output shape, spawn the CLI binary against a fixture store and snapshot stdout:
- pinnedOnly path: `hippo context --pinned-only`
- main path / markdown (default format): `hippo context --auto --budget 500`
- main path / json: `hippo context --auto --budget 500 --format json`
- main path / additional-context: `hippo context --auto --budget 500 --format additional-context`
- framing=observe: `hippo context --auto --framing observe`
- framing=suggest: `hippo context --auto --framing suggest`
- framing=assert: `hippo context --auto --framing assert`
- query='*' fallback (no args, no auto): `hippo context`
- hybrid search local-only: `hippo context "foo"` after `hippo remember "foo"`
- hybrid search with global: `hippo context "global_x"` after `hippo remember --global "global_x"`

These snapshots are committed to git pre-refactor (captured against master HEAD before T2 lands) and must remain unchanged through T7. **A snapshot diff after T5 implementation = byte-identical claim failed = T5 not done.**

**Step 2:** Implement `getContext(ctx, opts)` by reading cmdContext source end-to-end during execute and porting it.

**Execute-stage discipline (required):** before writing any extraction code, read `cli.ts` lines `3344-3659` (cmdContext function body) + `3661-3694` (printContextMarkdown helper) — ~350 lines total in two chunks. **Stop reading at line 3694** — line 3696+ is `autoDetectContext` (already a separate helper, just called from cmdContext; do not re-extract it) and 3734+ is `cmdEmbed` (unrelated). Note every external function called (loadAllEntries, loadActiveTaskSnapshot, loadLatestHandoff, listSessionEvents, computeScore-or-whatever, formatMarkdown/formatJson/formatAdditionalContext, autoDetectContext, detectScope, loadConfig, etc.). Note every `resolveTenantId({})` call site — every one of those becomes `ctx.tenantId`. Note every `console.log` / `process.stdout.write` — every one becomes result-object population.

Porting strategy: **bottom-up, test-driven**. (1) Port the pinnedOnly fast path first — smallest branch, fewest deps. Run snapshot test for `--pinned-only`. Green = commit checkpoint. (2) Port the main path's data-loading + scoring + budgeting (no rendering yet). Run api-level tests for default budget + tenant scoping + activeSnapshot. (3) Port each render path (markdown, json, additional-context, framing prefixes). Run snapshot tests per shape; green = commit checkpoint per format. (4) Rewire cmdContext to call api.getContext. Run all CLI snapshot tests. Green = T5 done.

Architecture:
- The pinned-only fast path stays a top-of-function early-return that returns a ContextResult.
- The main path builds entries → scores → packs to budget → renders by format.
- The render functions live in cli.ts (or a new `src/render-context.ts` if they grow past ~80 lines combined).

**Step 3:** Rewire `cmdContext` to parse flags → build ContextOpts → `await api.getContext(ctx, opts)` → if `result.rendered`, `process.stdout.write(result.rendered)`; if format=json, `console.log(JSON.stringify(result, null, 2))`.

**Step 4:** Full suite green. All 10 CLI snapshot tests from Step 1b green (zero stdout diff vs pre-refactor capture). Manual smokes for each format + pinnedOnly + auto.

**Step 5: Commit** `feat(api): extract getContext() from cmdContext — ~315 LoC into pure result + render wrapper`.

---

## Task 6: Rewire cmdOutcome to use the new api (+ audit-emission fix)

**Files:** Modify `src/cli.ts` cmdOutcome.

```typescript
function cmdOutcome(hippoRoot: string, flags: ...) {
  requireInit(hippoRoot);
  const good = Boolean(flags['good']);
  const bad = Boolean(flags['bad']);
  if (!good && !bad) { console.error('Specify --good or --bad'); process.exit(1); }
  const ctx: api.Context = { hippoRoot, tenantId: resolveTenantId({}), actor: 'cli' };
  const specificId = flags['id'] ? String(flags['id']) : null;
  let updated: number;
  if (specificId) {
    updated = api.outcome(ctx, [specificId], good).applied;
  } else {
    const r = api.outcomeForLastRecall(ctx, good);
    if (r.ids.length === 0) {
      console.log('No recent recall to apply outcome to. Use --id <id> to target a specific memory.');
      return;
    }
    updated = r.applied;
  }
  console.log(`Applied ${good ? 'positive' : 'negative'} outcome to ${updated} memor${updated === 1 ? 'y' : 'ies'}`);
}
```

**Behavior fix flagged (H1 from plan-eng-critic):** the current `cmdOutcome` does its own `readEntry → applyOutcome → writeEntry` inline and **silently skips** the `appendAuditEvent(op='outcome')` call that `api.outcome` emits. After T6, every successful `hippo outcome` invocation writes ONE `audit_log` row per affected memory id — matching the MCP `outcome` tool path which already does this via the same `api.outcome`. This is an intentional fix to a CLI/MCP asymmetry, not an accidental side effect. Documented as such in T7 CHANGELOG.

**Step 1:** Existing CLI outcome tests pass unchanged. **Add one new test** asserting that after `hippo outcome --good`, the `audit_log` table has the expected number of new rows (one per affected id, with op='outcome'). Grep `tests/**` for any existing test asserting `audit_log` row counts or absence — fix the assertion or document why no breakage.

**Step 2: Commit** `fix(cli): cmdOutcome routes through api.outcomeForLastRecall + api.outcome (emits audit_log)`.

---

## Task 7: CHANGELOG + version bump

CHANGELOG entry (1.11.3, prepended above 1.11.2):

> ### 1.11.3 (2026-05-23): api.ts refactor — getContext() + sleep() + outcomeForLastRecall()
>
> Internal refactor enabling future HTTP API expansion (planned v1.11.4) and the Python SDK (planned v0.1.0). Three new exports added to `src/api.ts`:
> - `getContext(ctx, opts): Promise<ContextResult>` — extracted from `cmdContext` (~315 inline lines collapsed into a pure async function + a presentation renderer in the CLI). Named `getContext` rather than `context` to avoid collision with the `Context` interface.
> - `sleep(ctx, opts): Promise<SleepResult>` — extracted from `cmdSleepCore` (Phase 2-6: consolidate / dedup / audit / share / ambient); returns structured counts for active/removed/merged/newSemantic/deduped/audit/shared/ambient instead of console-printing inside the core. The CLI log-file tee, console rendering, and the auto-learn pre-phase (Phase 1: learnFromRepo + learnFromMemoryMd, intrinsically host-bound) stay in the `cmdSleep` + `cmdSleepCore` wrappers. `deduplicateStore` moved to its own module (`src/dedupe.ts`).
> - `outcomeForLastRecall(ctx, good): {applied, ids}` — small wrapper around the existing `outcome()` that resolves `loadIndex().last_retrieval_ids` first.
>
> CLI commands (`hippo context`, `hippo sleep`) keep byte-identical stdout (covered by 10 new render-snapshot tests in `tests/cli-context-render-snapshot.test.ts` and the existing sleep smokes).
>
> **Behavior fix:** `hippo outcome` now emits one `audit_log` row per affected memory (op='outcome'), matching the MCP `outcome` tool path. Previously the CLI bypassed `api.outcome` and silently skipped the audit emission — an inconsistency between the CLI and MCP surfaces. Downstream consumers of `audit_log` will see new rows from CLI `outcome` invocations going forward; if you rely on counting CLI-vs-MCP audit rows separately, filter on the `actor` field (`'cli'` vs `'mcp'`).
>
> No public TypeScript API breakage — all `src/api.ts` exports are additive. Tenant-scoping audited: every `loadAllEntries`/`readEntry` in the new `api.getContext` uses `ctx.tenantId`, not `resolveTenantId({})`.

Version pins (6 manifests):
- package.json, package-lock.json (root + packages.['']), src/version.ts, openclaw.plugin.json, extensions/openclaw-plugin/{openclaw.plugin.json, package.json} — all 1.11.2 → 1.11.3.

**Commit** `docs+chore: CHANGELOG + version bump 1.11.2 → 1.11.3`.

---

## Verify

**Automated:**
- `npm test; echo "exit=$?"` — exit=0 with all existing tests passing + new api-level tests (4 files: api-context-sleep-contracts, api-outcome-for-last-recall, api-sleep, api-context) + 10 CLI render snapshot tests + 1 cmdOutcome audit-emission test.
- `npx tsc --noEmit` — clean.

**CLI render snapshot diff (the byte-identical gate):**
- All 10 snapshots in `tests/cli-context-render-snapshot.test.ts` (one per output shape; see T5 Step 1b) MUST match their pre-refactor capture. Any diff = re-work, not done.
- `hippo sleep --dry-run` stdout diff vs master HEAD must be empty (existing smoke).

**Manual smokes against a tmp HOME (cross-check the snapshot tests):**
- pinnedOnly: `hippo context --pinned-only`
- markdown default: `hippo context --auto --budget 500`
- json: `hippo context --auto --budget 500 --format json`
- additional-context: `hippo context --auto --budget 500 --format additional-context`
- framing × 3: `hippo context --auto --framing {observe|suggest|assert}`
- query fallback: `hippo context`
- sleep dry-run, full, --no-learn, --no-share
- outcome: `hippo remember "x" && hippo recall x && hippo outcome --good` (last-recall path) + `hippo outcome --id <id> --good` (specific-id path)

---

## Review

- `/self-review` on diff.
- `independent-review-critic`: brief on extraction quality, CLI byte-identical claim (render snapshots are the gate), tenant-scoping correctness in api.getContext, and the cmdOutcome audit-emission fix's CHANGELOG framing. The critic should grep for `resolveTenantId(` in the new code paths and confirm none are inside api.getContext or api.sleep.

---

## Ship + Deploy

- `/ship-check`, `ship-readiness-critic`.
- PR `refactor/api-context-sleep-outcome`, title `refactor(api): extract getContext() + sleep() + outcomeForLastRecall() (v1.11.3)`.
- Human-final-gate.
- npm publish 1.11.3, tag v1.11.3, GitHub Release.

---

## Success criteria

- [ ] `src/api.ts` exports `getContext`, `sleep`, `outcomeForLastRecall` with the types defined in Task 2.
- [ ] `cmdContext`, `cmdSleepCore`, `cmdOutcome` route through the new api.
- [ ] CLI byte-identical stdout for `hippo context` (10 render snapshot tests green) and `hippo sleep` (existing smoke green).
- [ ] `hippo outcome` emits one `audit_log` row per affected id (new test green); no existing test broken by the new rows.
- [ ] Tenant scoping audit clean (zero `resolveTenantId({})` inside api.getContext or api.sleep body).
- [ ] Full suite green, exit=0.
- [ ] 5 new test files: api-context-sleep-contracts, api-outcome-for-last-recall, api-sleep, api-context, cli-context-render-snapshot. (Plus existing cli-dedup tests continue to pass after deduplicateStore moves to src/dedupe.ts.)
- [ ] CHANGELOG 1.11.3 entry present (including the audit-emission behavior-fix note).
- [ ] Version 1.11.3 across all 6 manifests.
- [ ] PR merged, npm published.

---

## Out of scope (Episodes B + C)

- HTTP routes for /v1/outcome, /v1/context, /v1/sleep — Episode B (v1.11.4).
- Python SDK — Episode C (pip hippo-memory 0.1.0).
- `audit` HTTP route — Episode B candidate.
- Refactoring other large cli.ts handlers (cmdRecall, cmdTrace) — separate episodes if needed.
