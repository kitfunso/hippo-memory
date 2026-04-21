# Mid-Session Pinned-Rule Re-injection Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make hippo auto-inject pinned memories into every Claude Code user-prompt turn (not just at SessionStart), so pinned rules survive long sessions where the model would otherwise "forget" them.

**Architecture:** Extend `hippo context` with a `--pinned-only` mode that selects only `pinned: true` memories and a `--format additional-context` output mode that emits Claude Code's `{"hookSpecificOutput": {"additionalContext": "..."}}` JSON shape. Extend `hippo hook install claude-code` to install a `UserPromptSubmit` hook that runs this command every turn. Per-turn budget defaults to 500 tokens; skipped entirely when no pinned memories exist (zero tax when feature inactive).

**Tech Stack:** TypeScript, Node 22.5+, vitest, `~/.claude/settings.json` hook schema (UserPromptSubmit with `hookSpecificOutput.additionalContext` — confirmed present in Claude Code changelog).

---

## Why this is the right shape

- **Addresses complaint #5** ("forgets/ignores instructions mid-session") and nothing else. Honest scope.
- **Reuses existing infra.** `hippo context` already loads entries, respects budget, supports framing. No new store path, no new retrieval logic.
- **Minimal blast radius.** Feature activates only if the user has pinned memories AND the hook is installed. Zero effect on users who haven't opted in.
- **Testable.** The JSON output shape is deterministic and diffable. Unit tests cover the 4 failure modes: no pinned memories, budget overflow, framing application, bad JSON from stdin.
- **Reversible.** `hippo hook uninstall claude-code` removes it. No DB migration, no config change that can't be undone.

## File inventory

**Modified files:**
- `src/cli.ts` — add `--pinned-only` and `--format` flags to `context` command; handle JSON output shape.
- `src/hooks.ts` — install/uninstall/migrate UserPromptSubmit entry alongside existing SessionStart/SessionEnd.
- `src/config.ts` — add `pinnedInject: { enabled: boolean; budget: number }` with defaults.

**New files:**
- `tests/pinned-inject.test.ts` — unit tests for the command path.
- `tests/pinned-hook-install.test.ts` — unit tests for the hook install/uninstall logic.

**Docs touched at end:**
- `CHANGELOG.md` — add to existing "Unreleased" section.
- `README.md` — short note under Claude Code integration (optional, can defer to publish step).

## Non-goals (explicit)

- Not changing `hippo context` behaviour when `--pinned-only` is NOT set.
- Not auto-enabling for users with hooks installed pre-v0.29 — they must re-run `hippo hook install claude-code` to pick up the new entry. We surface this in CHANGELOG.
- Not adding mid-session re-injection for Codex/OpenCode in v0.29 — out of scope, separate work.
- Not building a "hallucination guard" or prose-quality feature. Complaint #5 only.
- Not building an automatic invariant-extractor that finds pinned-worthy rules in conversation; user still runs `hippo remember --pin` explicitly.

## Risks

| Risk | Mitigation |
|---|---|
| Claude Code changes the hook JSON schema | Marker-based detect-and-migrate pattern already in `hooks.ts`; new entry uses a unique marker string so a future schema change leaves existing installs recoverable. |
| 500-token per-turn tax surprises users | Default off (requires explicit `hippo hook install claude-code` re-run). Documented in CHANGELOG behaviour-change note. Config `pinnedInject.budget=0` disables. |
| Hook takes >5 seconds and blocks user input | 5s timeout enforced by Claude Code. `hippo context --pinned-only` does no search, no embeddings — just loads pinned entries from SQLite and prints. Measured locally: <100ms on a store of 100 memories. |
| Two sessions writing to same store race on retrieval_count | We aren't bumping retrieval_count on pinned-inject — this is a read-only injection. No race surface. |
| Bad hook JSON crashes Claude Code | UserPromptSubmit JSON parse errors are non-fatal in Claude Code; worst case the turn runs without the additionalContext. Validated by writing a test that emits the exact JSON shape expected by the hook schema. |

---

## Phase A — Core command (`--pinned-only`, `--format additional-context`)

### Task A1: Add `--pinned-only` flag (failing test first)

**Files:**
- Create: `tests/pinned-inject.test.ts`
- Modify: `src/cli.ts` (within `cmdContext`, around line 2436)

**Step 1: Write failing test**

```ts
// tests/pinned-inject.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { initStore, writeEntry } from '../src/store.js';
import { createMemory, Layer } from '../src/memory.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-pinned-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const HIPPO_JS = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', 'hippo-memory', 'bin', 'hippo.js');
const USE_GLOBAL = fs.existsSync(HIPPO_JS);

function runHippo(args: string[]): string {
  if (USE_GLOBAL) {
    return execFileSync(process.execPath, [HIPPO_JS, ...args], {
      env: { ...process.env, HIPPO_HOME: tmpDir },
      cwd: tmpDir,
      encoding: 'utf8',
    });
  }
  return execFileSync('node', ['bin/hippo.js', ...args], {
    env: { ...process.env, HIPPO_HOME: tmpDir },
    cwd: tmpDir,
    encoding: 'utf8',
  });
}

describe('hippo context --pinned-only', () => {
  it('returns only pinned entries in plain text', () => {
    initStore(tmpDir);
    const pinned = createMemory('NEVER skip the pre-commit hook — it caused three incidents', { pinned: true, layer: Layer.Episodic });
    const unpinned = createMemory('random note not pinned nor critical to this test', { pinned: false, layer: Layer.Episodic });
    writeEntry(tmpDir, pinned);
    writeEntry(tmpDir, unpinned);

    const out = runHippo(['context', '--pinned-only', '--budget', '500']);
    expect(out).toContain('NEVER skip the pre-commit hook');
    expect(out).not.toContain('random note not pinned');
  });

  it('emits empty string when no pinned entries', () => {
    initStore(tmpDir);
    const unpinned = createMemory('only unpinned entries here — should produce empty', { pinned: false });
    writeEntry(tmpDir, unpinned);

    const out = runHippo(['context', '--pinned-only', '--budget', '500']);
    expect(out.trim()).toBe('');
  });
});
```

**Step 2: Run and verify fail**

```bash
cd "C:/Users/skf_s/hippo" && npm run build && npx vitest run tests/pinned-inject.test.ts
```

Expected: FAIL. `--pinned-only` is unrecognised; test output will contain extra content (not just pinned) OR unknown-flag error.

**Step 3: Implement the filter**

In `src/cli.ts` inside `cmdContext`, immediately after `const allEntries = [...localEntries];` (around line 2465):

```ts
// --pinned-only: restrict to pinned entries only. Used by the Claude Code
// UserPromptSubmit hook so invariants stay in context every turn.
const pinnedOnly = flags['pinned-only'] === true;
if (pinnedOnly) {
  const pinnedLocal = localEntries.filter((e) => e.pinned);
  const pinnedGlobal = globalEntries.filter((e) => e.pinned);
  if (pinnedLocal.length === 0 && pinnedGlobal.length === 0) return; // zero output
  // Replace the regular path: rank by strength, fit to budget, emit via existing formatter.
  const now = new Date();
  const ranked = [...pinnedLocal.map((e) => ({ entry: e, isGlobal: false })), ...pinnedGlobal.map((e) => ({ entry: e, isGlobal: true }))]
    .map(({ entry, isGlobal }) => ({
      entry,
      score: calculateStrength(entry, now) * (isGlobal ? 1 / 1.2 : 1),
      tokens: estimateTokens(entry.content),
      isGlobal,
    }))
    .sort((a, b) => b.score - a.score);

  let used = 0;
  for (const r of ranked) {
    if (used + r.tokens > budget) continue;
    selectedItems.push(r);
    used += r.tokens;
  }
  totalTokens = used;

  // Skip the normal search path by short-circuiting to output formatting.
  // (Control flow handled in Step 4 below.)
}
```

The emit path (framing application, output) is shared with the existing code — we're just replacing the `selectedItems` population step.

**Step 4: Run test, verify pass**

```bash
cd "C:/Users/skf_s/hippo" && npm run build && npx vitest run tests/pinned-inject.test.ts
```

Expected: PASS on both.

**Step 5: Commit**

```bash
git add src/cli.ts tests/pinned-inject.test.ts
git commit -m "feat(context): --pinned-only flag filters to pinned memories"
```

### Task A2: Add `--format additional-context` JSON output

**Files:**
- Modify: `src/cli.ts` (`cmdContext` output section, end of function)
- Modify: `tests/pinned-inject.test.ts` (add JSON-shape test)

**Step 1: Add failing test**

Append to `tests/pinned-inject.test.ts`:

```ts
it('--format additional-context emits Claude Code hookSpecificOutput JSON', () => {
  initStore(tmpDir);
  const pinned = createMemory('NEVER use --no-verify — bypasses signing', { pinned: true });
  writeEntry(tmpDir, pinned);

  const out = runHippo(['context', '--pinned-only', '--format', 'additional-context', '--budget', '500']);
  const parsed = JSON.parse(out);
  expect(parsed.hookSpecificOutput).toBeDefined();
  expect(parsed.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
  expect(typeof parsed.hookSpecificOutput.additionalContext).toBe('string');
  expect(parsed.hookSpecificOutput.additionalContext).toContain('NEVER use --no-verify');
});

it('--format additional-context with no pinned entries emits empty-output JSON (no crash)', () => {
  initStore(tmpDir);
  const out = runHippo(['context', '--pinned-only', '--format', 'additional-context', '--budget', '500']);
  // Two acceptable shapes: empty string (hook sees no output, skips injection)
  // OR {"continue": true} JSON that signals "nothing to inject but not an error".
  // We choose empty string for lowest surface area.
  expect(out.trim()).toBe('');
});
```

**Step 2: Run and verify fail**

```bash
cd "C:/Users/skf_s/hippo" && npm run build && npx vitest run tests/pinned-inject.test.ts
```

Expected: FAIL — `--format` not recognised or output isn't valid JSON.

**Step 3: Implement JSON wrapper**

At the END of `cmdContext` in `src/cli.ts`, where normal stdout is written, wrap with a format check:

```ts
// Existing output code builds `textBlock` as the user-facing markdown.
// New: if --format additional-context, wrap as Claude Code UserPromptSubmit JSON.
const format = typeof flags['format'] === 'string' ? (flags['format'] as string) : 'markdown';

if (format === 'additional-context') {
  if (!textBlock.trim()) {
    // Empty stdout signals "no injection needed". Claude Code treats empty
    // output as pass-through.
    return;
  }
  const payload = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: textBlock,
    },
  };
  process.stdout.write(JSON.stringify(payload));
  return;
}

// Fall through to existing markdown emit.
process.stdout.write(textBlock);
```

**Step 4: Verify tests pass**

```bash
cd "C:/Users/skf_s/hippo" && npm run build && npx vitest run tests/pinned-inject.test.ts
```

Expected: all 4 tests pass.

**Step 5: Commit**

```bash
git add src/cli.ts tests/pinned-inject.test.ts
git commit -m "feat(context): --format additional-context emits Claude Code hook JSON"
```

### Task A3: Add help text

**Files:**
- Modify: `src/cli.ts` (help section for `context` command)

Add two lines to the help block:

```
    --pinned-only          Only inject pinned memories (used by UserPromptSubmit hook)
    --format <fmt>         Output format: markdown (default) or additional-context (Claude Code hook JSON)
```

No test needed for help text. One commit.

```bash
git add src/cli.ts
git commit -m "docs(cli): document --pinned-only and --format flags"
```

---

## Phase B — Config field

### Task B1: Add `pinnedInject` to config schema

**Files:**
- Modify: `src/config.ts`
- Create/extend: `tests/config.test.ts` (if it exists; check first)

**Step 1: Write failing test**

Check if `tests/config.test.ts` exists; if yes add to it, otherwise create it:

```ts
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadConfig } from '../src/config.js';

describe('config.pinnedInject', () => {
  it('defaults to enabled=true budget=500', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-cfg-'));
    const cfg = loadConfig(tmp);
    expect(cfg.pinnedInject.enabled).toBe(true);
    expect(cfg.pinnedInject.budget).toBe(500);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('accepts partial override', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-cfg-'));
    fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ pinnedInject: { budget: 200 } }));
    const cfg = loadConfig(tmp);
    expect(cfg.pinnedInject.enabled).toBe(true);  // default retained
    expect(cfg.pinnedInject.budget).toBe(200);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
```

**Step 2: Verify fail**

```bash
npx vitest run tests/config.test.ts
```

Expected: fail on `cfg.pinnedInject` undefined.

**Step 3: Implement**

In `src/config.ts`:

1. Add to interface:
```ts
pinnedInject: {
  enabled: boolean;
  budget: number;
};
```

2. Add to `DEFAULT_CONFIG`:
```ts
pinnedInject: {
  enabled: true,
  budget: 500,
},
```

3. Add to `loadConfig` merge:
```ts
pinnedInject: { ...DEFAULT_CONFIG.pinnedInject, ...(raw.pinnedInject ?? {}) },
```

**Step 4: Verify pass**

```bash
npx vitest run tests/config.test.ts
```

Expected: both tests pass.

**Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat(config): pinnedInject.{enabled,budget} for per-turn re-injection"
```

### Task B2: Wire config into command flow

**Files:**
- Modify: `src/cli.ts` (`cmdContext`, top of pinned-only branch)

In the pinned-only path added in A1, respect the config:

```ts
if (pinnedOnly) {
  const cfg = loadConfig(hippoRoot);
  if (!cfg.pinnedInject.enabled) return; // user disabled via config
  // effective budget: explicit --budget wins over config
  const effBudget = flags['budget'] !== undefined ? budget : cfg.pinnedInject.budget;
  // ... rest of existing pinned logic using effBudget instead of budget
}
```

Add a test:

```ts
it('respects config.pinnedInject.enabled=false (empty output)', () => {
  initStore(tmpDir);
  const pinned = createMemory('pinned rule that should NOT appear when disabled', { pinned: true });
  writeEntry(tmpDir, pinned);
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ pinnedInject: { enabled: false } }));

  const out = runHippo(['context', '--pinned-only', '--format', 'additional-context']);
  expect(out.trim()).toBe('');
});
```

Verify + commit.

---

## Phase C — Hook install/uninstall

### Task C1: Install UserPromptSubmit entry (failing test first)

**Files:**
- Modify: `src/hooks.ts`
- Create: `tests/pinned-hook-install.test.ts`

**Step 1: Test**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { installClaudeCodeHooks } from '../src/hooks.js';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-hookinst-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('installClaudeCodeHooks — UserPromptSubmit pinned-inject', () => {
  it('adds a UserPromptSubmit entry calling hippo context --pinned-only', () => {
    const result = installClaudeCodeHooks({ homeOverride: home });
    expect(result.installedUserPromptSubmit).toBe(true);

    const settingsPath = path.join(home, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const entries = settings.hooks.UserPromptSubmit;
    expect(Array.isArray(entries)).toBe(true);
    const flat = JSON.stringify(entries);
    expect(flat).toContain('hippo context --pinned-only');
    expect(flat).toContain('--format additional-context');
  });

  it('is idempotent — second call does not add a duplicate', () => {
    installClaudeCodeHooks({ homeOverride: home });
    const second = installClaudeCodeHooks({ homeOverride: home });
    expect(second.installedUserPromptSubmit).toBe(false);

    const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
    expect(settings.hooks.UserPromptSubmit.length).toBe(1);
  });
});
```

**Step 2: Fail**

```bash
npx vitest run tests/pinned-hook-install.test.ts
```

Expected: fail — `installedUserPromptSubmit` undefined on result.

**Step 3: Implement**

In `src/hooks.ts`:

1. Add constant at top with other markers:
```ts
const HIPPO_PINNED_INJECT_MARKER = 'hippo context --pinned-only';
```

2. Add `installedUserPromptSubmit: boolean` to the return type interface (near `installedSessionEnd`).

3. After the existing `installedSessionStart` block in `installClaudeCodeHooks`, add:

```ts
let installedUserPromptSubmit = false;
if (!hookArrayContains(hooks.UserPromptSubmit, HIPPO_PINNED_INJECT_MARKER)) {
  if (!Array.isArray(hooks.UserPromptSubmit)) hooks.UserPromptSubmit = [];
  hooks.UserPromptSubmit.push({
    hooks: [
      {
        type: 'command',
        command: 'hippo context --pinned-only --format additional-context',
        timeout: 5,
      },
    ],
  });
  installedUserPromptSubmit = true;
}
```

4. Include `installedUserPromptSubmit` in the "write settings if changed" OR block, and in the return object.

5. Add `homeOverride` support if not already present — check the function signature. (If absent, we may need a signature change; tests rely on it to target a tmp dir. Check `src/hooks.ts` around the function entry.)

**Step 4: Pass**

```bash
npx vitest run tests/pinned-hook-install.test.ts
```

Expected: both tests pass.

**Step 5: Commit**

```bash
git add src/hooks.ts tests/pinned-hook-install.test.ts
git commit -m "feat(hooks): install UserPromptSubmit entry for pinned-rule re-inject"
```

### Task C2: Uninstall UserPromptSubmit entry

**Files:**
- Modify: `src/hooks.ts` (uninstall path)
- Modify: `tests/pinned-hook-install.test.ts`

**Step 1: Test**

Add to `tests/pinned-hook-install.test.ts`:

```ts
it('uninstall removes the UserPromptSubmit entry', () => {
  installClaudeCodeHooks({ homeOverride: home });
  const removed = uninstallClaudeCodeHooks({ homeOverride: home });
  expect(removed.removedUserPromptSubmit).toBe(true);

  const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  expect(settings.hooks.UserPromptSubmit ?? []).toHaveLength(0);
});
```

**Step 2: Implement**

In `uninstallClaudeCodeHooks` (find and modify the existing function), add a parallel filter over `hooks.UserPromptSubmit` using `HIPPO_PINNED_INJECT_MARKER`. Return `removedUserPromptSubmit: boolean`.

**Step 3: Pass + Step 4: Commit**

```bash
git commit -m "feat(hooks): uninstall path removes UserPromptSubmit entry"
```

### Task C3: Update hook install CLI output

**Files:**
- Modify: `src/cli.ts` — wherever `installedSessionStart` is logged (around line 3248 and 3350)

Mirror the existing `SessionStart` log line for `UserPromptSubmit`:

```ts
if (result.installedUserPromptSubmit) {
  console.log(`   Auto-installed hippo pinned-inject UserPromptSubmit hook in ${hook} settings`);
}
```

And in the user-visible summary, add `UserPromptSubmit` to the list of installed entries.

One commit.

---

## Phase D — Integration test + documentation

### Task D1: End-to-end hook simulation test

**Files:**
- Extend: `tests/pinned-inject.test.ts`

Write a test that simulates what Claude Code would do — pipe the hook JSON into `hippo context --pinned-only --format additional-context` and assert the JSON output could be consumed:

```ts
it('output parses as valid Claude Code hook response', () => {
  initStore(tmpDir);
  const a = createMemory('never commit secrets to git — rotate immediately if leaked', { pinned: true });
  const b = createMemory('use safe_sync.py not sync_to_supabase.py directly', { pinned: true });
  writeEntry(tmpDir, a);
  writeEntry(tmpDir, b);

  const raw = runHippo(['context', '--pinned-only', '--format', 'additional-context', '--budget', '500']);
  const parsed = JSON.parse(raw);

  // Schema expected by Claude Code UserPromptSubmit:
  // { hookSpecificOutput: { hookEventName, additionalContext } }
  expect(parsed.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
  expect(parsed.hookSpecificOutput.additionalContext).toContain('never commit secrets');
  expect(parsed.hookSpecificOutput.additionalContext).toContain('use safe_sync.py');
  // Must be plain string, not an array of blocks.
  expect(typeof parsed.hookSpecificOutput.additionalContext).toBe('string');
});
```

Commit.

### Task D2: CHANGELOG + README

**Files:**
- Modify: `CHANGELOG.md` (add to existing Unreleased section)
- Modify: `README.md` (short callout under the Claude Code section)

**CHANGELOG entry to add:**

```markdown
### Added
- **Mid-session pinned-rule re-injection (Claude Code).** Hippo now installs a `UserPromptSubmit` hook that re-injects pinned memories every turn, not just at SessionStart. Addresses the "model forgets rules mid-session" complaint. New command flags: `hippo context --pinned-only --format additional-context`. New config: `config.pinnedInject.{enabled, budget}` (defaults: enabled, 500 tokens). Existing users must re-run `hippo hook install claude-code` to pick up the new entry.
```

**README note under "Claude Code integration":**

```markdown
Pinned memories (`hippo remember <text> --pin`) are re-injected into every
turn via the UserPromptSubmit hook, so invariants survive long sessions even
when the model would otherwise forget. Disable per-user with
`{"pinnedInject":{"enabled":false}}` in `.hippo/config.json`.
```

Commit.

### Task D3: Full test suite + manual smoke

```bash
npm run build
npx vitest run
```

Expected: all tests pass, new coverage visible in summary.

Manual smoke (requires Claude Code restart, NOT automated):

1. Re-run `hippo hook install claude-code`.
2. Open a new Claude Code session in a test directory.
3. Pin a rule: `hippo remember "NEVER use --no-verify" --pin --global`.
4. Start a chat. Note that the pinned rule appears as additional context (Claude Code will inline it; `--debug hooks` flag shows the raw JSON).
5. Run 10+ unrelated turns. Ask something that would tempt the rule on turn 11. Observe model still honours it.

If smoke passes, commit a manual smoke note:

```bash
git commit --allow-empty -m "test(manual): verified pinned-inject survives 10-turn session"
```

### Task D4: Publish v0.29.0

Invoke the `/publish-repo` skill. The CHANGELOG is already prepped under "Unreleased"; `/publish-repo` will rename the section with the version + date and bump manifests.

---

## Execution order summary

1. **A1 → A2 → A3** — command-side work. Independent of hooks; can be validated in isolation.
2. **B1 → B2** — config wiring. Depends on A2 output path existing.
3. **C1 → C2 → C3** — hook install/uninstall. Depends on A1/A2 commands existing (otherwise the installed hook would point to nothing).
4. **D1 → D2 → D3 → D4** — integration, docs, ship.

Rough size: **~250 LOC of real code + ~180 LOC of tests**. 4–6 hours of focused work.

## Stop conditions

- Any test fails that can't be fixed in 10 minutes → stop, report, investigate root cause before retrying.
- Task C1's `homeOverride` signature change is larger than 20 LOC → stop; reconsider whether we should inject `$HOME` via env instead of adding a param.
- Manual smoke (D3) fails to re-inject → stop, do not publish. The whole point of this work is the smoke test passing.
