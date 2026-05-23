# OpenCode Plugin Fix Implementation Plan — Revision 1

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Revision history:**
- **Rev 0** (2026-05-23 13:02 UTC): initial draft. plan-eng-critic returned `fail` (score 62) with 2 crit + 5 high + 3 med findings: (1) migration silently no-ops on invalid JSON — the literal failure mode being fixed; (2) `hippo setup` pluginTools branch only prints notes — would silently skip opencode install after kind flip; (3) existing tests directly use opencode in installJsonHooks — must explicitly update, not "if found"; (4) `@opencode-ai/plugin` import unverified (WebFetch on npm returned 403); (5) substring-match isHippoOwned has false-positive blast-radius risk; (6) marker not future-proof; (7) missing Bun-$ guard; (8) test convention not aligned with existing withFakeHome helper; (9) commit sequence breaks bisect; (10) uninstall doesn't run legacy migration.
- **Rev 1** (2026-05-23 13:07 UTC): every must_fix item addressed. Verified cli.ts:4444-4450 pluginTools branch — confirmed critic was right (only `console.log(tool.notes)`, no installer). Verified tests/hooks.test.ts:19 `withFakeHome` helper — extracted to shared module in Task 0 below. Verified tests/hooks.test.ts:231-257 + :355 — explicit deletions/updates added. Verified `@opencode-ai/plugin` unconfirmable from this sandbox (npm 403) — switched plugin source to type-free signature, eliminating the dependency question. Migration on invalid JSON returns structured error. `isHippoOwned` switched from substring match to structural per-entry filter. Idempotence checks marker AND content match. Bun `$` guard added. Commit sequence reordered: add-new-first, atomic refactor-narrow-last. uninstall now also runs migration.

**Goal:** Fix [hippo-memory issue #24](https://github.com/kitfunso/hippo-memory/issues/24) at root by replacing the wrong assumption (`opencode` uses Claude Code's JSON-hook format) with opencode's actual integration model (a TypeScript plugin loaded from `~/.config/opencode/plugins/`). Migrate users on v1.10.x-v1.11.1 who have the broken `hooks` block in their `opencode.json` so opencode launches again.

**Architecture:** Same overall direction as Rev 0 but tightened: extract a shared `tests/_helpers/with-fake-home.ts` from the existing inline helper to align new test file with project conventions; ship the plugin source as a constant in `src/hooks.ts` with a type-free signature (no `import type` dependency on `@opencode-ai/plugin`) and a defensive `if (typeof $ !== 'function') return;` guard; structural per-entry `hooks` filter (not a substring-match wipe) when migrating opencode.json; idempotence keyed on marker AND content match so future plugin source revisions overwrite; uninstall also runs the legacy migration; `cmdSetup` pluginTools branch explicitly patched to install opencode; structured error return on unparseable opencode.json so the CLI can surface "manual fix needed".

**Tech Stack:** TypeScript, Node fs, vitest (real FS, no mocks per project rule). Plugin file has NO type imports (eliminates `@opencode-ai/plugin` publication-status question). Bun `$` shell invocation at runtime, with a defensive `typeof $ !== 'function'` guard so a non-Bun deployment fails closed instead of crashing the opencode session.

---

## Research notes (completed before this plan)

Per `/writing-plans` § "Research Before Writing", and updated for Rev 1:

- **Source-read all of `src/hooks.ts` (753 lines)**. Confirmed every line-number claim in Rev 0.
- **Verified `cli.ts:4444-4450` pluginTools branch** prints `tool.notes` only — confirms Rev 0 critic CRIT #2. The plan now patches this branch explicitly (Task 6).
- **Verified `tests/hooks.test.ts`**: `withFakeHome` helper at line 19 sets BOTH `HOME` and `USERPROFILE`; existing `describe('installJsonHooks(opencode)')` block runs lines 231-257 (2 tests); `detectInstalledTools` assertion at line 355 expects `opencode kind === 'json-hook'`. All 3 explicitly addressed in Task 3b and Task 5.
- **Verified opencode plugin API** at https://opencode.ai/docs/plugins/ in discover.
- **`@opencode-ai/plugin` npm publication status: UNVERIFIABLE from this sandbox** (npmjs.com returned 403 to WebFetch). Rev 1 sidesteps by using a type-free plugin signature; the `Plugin` type was only convenience, not required for opencode to load the plugin.

---

## Task 0: Branch + extract shared test helper

**Files:**
- Working tree.
- Create: `tests/_helpers/with-fake-home.ts`.
- Modify: `tests/hooks.test.ts` (import the helper instead of declaring inline).

**Step 1:** `git checkout -b fix/opencode-plugin-installer` from master (tip `098b095`).

**Step 2:** Create `tests/_helpers/with-fake-home.ts`:

```typescript
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Each test gets its own fake $HOME so we never touch the real
 * ~/.claude/settings.json, ~/.config/opencode/opencode.json, or
 * ~/.config/opencode/plugins/ on the machine running the tests.
 *
 * Sets HOME on POSIX and USERPROFILE on Windows; restores both on cleanup.
 * Extracted from tests/hooks.test.ts 2026-05-23 so the opencode plugin
 * install tests use the same isolation pattern.
 */
export function withFakeHome(prefix = 'hippo-test-'): { cleanup: () => void; home: string } {
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.HOME = fake;
  process.env.USERPROFILE = fake;
  return {
    home: fake,
    cleanup: () => {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevUserProfile;
      fs.rmSync(fake, { recursive: true, force: true });
    },
  };
}
```

**Step 3:** Modify `tests/hooks.test.ts` — replace the inline `withFakeHome` at lines 19-33 with `import { withFakeHome } from './_helpers/with-fake-home.js';`. This is a pure refactor; no behavior change.

**Step 4:** Run `npm test -- tests/hooks.test.ts`. Expected: all existing tests still pass (this is a refactor, no test logic changed).

**Step 5: Commit** `refactor(tests): extract withFakeHome helper to tests/_helpers/`.

---

## Task 1: Add `OPENCODE_PLUGIN_SOURCE` constant (type-free)

**Files:**
- Modify: `src/hooks.ts` (add new exports — no signature changes yet).
- Create: `tests/opencode-plugin-install.test.ts` (initial — content-of-plugin-source tests).

**Step 1: Write failing tests:**

```typescript
import { describe, it, expect } from 'vitest';
import { OPENCODE_PLUGIN_SOURCE, HIPPO_OPENCODE_PLUGIN_MARKER } from '../src/hooks.js';

describe('OPENCODE_PLUGIN_SOURCE', () => {
  it('contains the versioned hippo marker', () => {
    expect(OPENCODE_PLUGIN_SOURCE).toContain(HIPPO_OPENCODE_PLUGIN_MARKER);
    expect(HIPPO_OPENCODE_PLUGIN_MARKER).toMatch(/^HIPPO_OPENCODE_PLUGIN_V\d+$/);
  });
  it('handles session.idle and session.created events', () => {
    expect(OPENCODE_PLUGIN_SOURCE).toContain('session.idle');
    expect(OPENCODE_PLUGIN_SOURCE).toContain('session.created');
  });
  it('guards against non-Bun runtimes (typeof $ check)', () => {
    expect(OPENCODE_PLUGIN_SOURCE).toMatch(/typeof\s+\$\s*!==\s*['"]function['"]/);
  });
  it('uses no type imports (type-free signature)', () => {
    // Avoids the unresolved @opencode-ai/plugin dependency at install time.
    expect(OPENCODE_PLUGIN_SOURCE).not.toContain('import type');
    expect(OPENCODE_PLUGIN_SOURCE).not.toContain('@opencode-ai/plugin');
  });
});
```

**Step 2:** Run — expected FAIL on imports.

**Step 3: Add to `src/hooks.ts`** after line 110 (after `HIPPO_CODEX_WRAPPER_MARKER`):

```typescript
const HIPPO_OPENCODE_PLUGIN_MARKER = 'HIPPO_OPENCODE_PLUGIN_V1';

/**
 * The opencode plugin file we install at ~/.config/opencode/plugins/hippo.ts.
 *
 * Per https://opencode.ai/docs/plugins/, plugins are TS/JS modules exporting an
 * async function returning hooks. We subscribe to `event` and route:
 *   session.idle    → `hippo session-end` (Claude Code's SessionEnd equiv)
 *   session.created → `hippo last-sleep` (Claude Code's SessionStart equiv)
 *
 * Design choices the critic forced into Rev 1:
 *
 * 1. No `import type { Plugin } from "@opencode-ai/plugin"`. The package's
 *    npm publication status was unverifiable from the build sandbox; an
 *    unresolved import would crash plugin load. opencode infers plugin shape
 *    from the returned object, so the type annotation is convenience-only.
 *
 * 2. Defensive `typeof $ !== 'function'` guard. opencode runs in Bun (where
 *    `$` is the shell-template helper), but a future Node-mode deployment
 *    would have `$` undefined and the plugin would ReferenceError on every
 *    session.idle, killing opencode sessions in a hard-to-recover way (the
 *    idempotence marker prevents re-install). Fail closed, log a warning,
 *    let opencode continue.
 *
 * 3. `.quiet().nothrow()` on each `$\`...\`` so a missing hippo binary (e.g.
 *    PATH-misconfigured user) does NOT throw out of the event handler and
 *    crash the opencode session.
 *
 * 4. UserPromptSubmit equivalent NOT wired. opencode's `message.updated`
 *    fires per-token; per-prompt-submit is not a clean opencode event. Users
 *    who want pinned-context auto-injection can call `hippo context` via the
 *    MCP server.
 *
 * 5. Versioned marker `HIPPO_OPENCODE_PLUGIN_V1` allows future versions to
 *    overwrite cleanly; install checks marker AND content equality so a
 *    plugin-source revision under the same V1 marker re-writes the file.
 */
export const OPENCODE_PLUGIN_SOURCE = `// ${HIPPO_OPENCODE_PLUGIN_MARKER}
// hippo-memory opencode plugin. Re-install with \`hippo hook install opencode\`.
// Source of truth: src/hooks.ts OPENCODE_PLUGIN_SOURCE in https://github.com/kitfunso/hippo-memory

export const HippoPlugin = async ({ $ }) => {
  return {
    event: async ({ event }) => {
      // Defense in depth: opencode currently runs in Bun where $ is the shell
      // template helper. A non-Bun runtime would crash the plugin on first
      // event fire; fail closed instead so opencode keeps working.
      if (typeof $ !== "function") return;
      try {
        if (event.type === "session.idle") {
          await $\`hippo session-end\`.quiet().nothrow();
        } else if (event.type === "session.created") {
          await $\`hippo last-sleep\`.quiet().nothrow();
        }
      } catch {
        // hippo CLI not on PATH or other failure — never crash the host session.
      }
    },
  };
};
`;

export { HIPPO_OPENCODE_PLUGIN_MARKER };
```

**Step 4:** Run tests — expected 4 pass.

**Step 5: Commit** `feat(hooks): add OPENCODE_PLUGIN_SOURCE plugin file constant`.

---

## Task 2: Add `installOpencodePlugin` / `uninstallOpencodePlugin` + structural migration

**Files:**
- Modify: `src/hooks.ts` (add new exported functions, ~120 lines, after `uninstallJsonHooks` around line 735).
- Modify: `tests/opencode-plugin-install.test.ts` (add install/uninstall/migration tests).

**Step 1: Write failing tests** (using the extracted `withFakeHome` helper):

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { withFakeHome } from './_helpers/with-fake-home.js';
import {
  installOpencodePlugin,
  uninstallOpencodePlugin,
  resolveOpencodePluginPath,
  HIPPO_OPENCODE_PLUGIN_MARKER,
  OPENCODE_PLUGIN_SOURCE,
} from '../src/hooks.js';

describe('installOpencodePlugin (real-FS)', () => {
  let env: { cleanup: () => void; home: string };
  beforeEach(() => { env = withFakeHome('hippo-opencode-'); });
  afterEach(() => { env.cleanup(); });

  it('writes a TS plugin file with the hippo marker on a fresh host', () => {
    const result = installOpencodePlugin();
    expect(result.installed).toBe(true);
    expect(result.migratedLegacyHooks).toBe(false);
    expect(result.jsonRepairFailed).toBe(false);
    expect(fs.readFileSync(resolveOpencodePluginPath(), 'utf8')).toContain(HIPPO_OPENCODE_PLUGIN_MARKER);
  });

  it('is idempotent when content matches', () => {
    installOpencodePlugin();
    const result2 = installOpencodePlugin();
    expect(result2.installed).toBe(false);
  });

  it('overwrites when marker matches but content differs (future-proof for V1-revision)', () => {
    const pluginPath = resolveOpencodePluginPath();
    fs.mkdirSync(path.dirname(pluginPath), { recursive: true });
    // Stale V1 plugin with old content (e.g. shipped in a prior 1.11.x).
    fs.writeFileSync(pluginPath, `// ${HIPPO_OPENCODE_PLUGIN_MARKER}\n// stale\n`);
    const result = installOpencodePlugin();
    expect(result.installed).toBe(true);
    expect(fs.readFileSync(pluginPath, 'utf8')).toBe(OPENCODE_PLUGIN_SOURCE);
  });

  it('migrates: removes only hippo-owned hook entries from opencode.json', () => {
    const opencodeJsonPath = path.join(env.home, '.config', 'opencode', 'opencode.json');
    fs.mkdirSync(path.dirname(opencodeJsonPath), { recursive: true });
    fs.writeFileSync(opencodeJsonPath, JSON.stringify({
      theme: 'dark',
      hooks: {
        SessionEnd: [
          { hooks: [{ type: 'command', command: 'hippo session-end --log-file ...', timeout: 5 }] },
          { hooks: [{ type: 'command', command: 'echo my own hook', timeout: 5 }] },
        ],
        SessionStart: [{ hooks: [{ type: 'command', command: 'hippo last-sleep --path ...', timeout: 5 }] }],
      },
    }, null, 2));

    const result = installOpencodePlugin();
    expect(result.migratedLegacyHooks).toBe(true);

    const after = JSON.parse(fs.readFileSync(opencodeJsonPath, 'utf8'));
    expect(after.theme).toBe('dark');
    // SessionStart was 100% hippo → key removed; SessionEnd had a non-hippo
    // entry → key preserved with only the non-hippo entry left.
    expect(after.hooks.SessionStart).toBeUndefined();
    expect(after.hooks.SessionEnd).toHaveLength(1);
    expect(JSON.stringify(after.hooks.SessionEnd)).toContain('my own hook');
  });

  it('drops the empty hooks key entirely when nothing survives', () => {
    const opencodeJsonPath = path.join(env.home, '.config', 'opencode', 'opencode.json');
    fs.mkdirSync(path.dirname(opencodeJsonPath), { recursive: true });
    fs.writeFileSync(opencodeJsonPath, JSON.stringify({
      hooks: {
        SessionEnd: [{ hooks: [{ type: 'command', command: 'hippo session-end --log-file ...' }] }],
      },
    }, null, 2));
    installOpencodePlugin();
    const after = JSON.parse(fs.readFileSync(opencodeJsonPath, 'utf8'));
    expect(after.hooks).toBeUndefined();
  });

  it('returns jsonRepairFailed=true when opencode.json is unparseable', () => {
    const opencodeJsonPath = path.join(env.home, '.config', 'opencode', 'opencode.json');
    fs.mkdirSync(path.dirname(opencodeJsonPath), { recursive: true });
    fs.writeFileSync(opencodeJsonPath, '{ "hooks": ["unterminated string ');
    const result = installOpencodePlugin();
    expect(result.installed).toBe(true);          // plugin file still written
    expect(result.migratedLegacyHooks).toBe(false); // nothing migrated
    expect(result.jsonRepairFailed).toBe(true);     // structured error surfaced
  });

  it('does NOT create opencode.json on a fresh install with no legacy block', () => {
    installOpencodePlugin();
    const opencodeJsonPath = path.join(env.home, '.config', 'opencode', 'opencode.json');
    expect(fs.existsSync(opencodeJsonPath)).toBe(false);
  });

  it('leaves a non-hippo hooks key alone (false-positive defense)', () => {
    const opencodeJsonPath = path.join(env.home, '.config', 'opencode', 'opencode.json');
    fs.mkdirSync(path.dirname(opencodeJsonPath), { recursive: true });
    // A user command that coincidentally mentions "hippo sleep" inside its
    // payload but is NOT a hippo-owned hook entry — should survive.
    fs.writeFileSync(opencodeJsonPath, JSON.stringify({
      hooks: {
        SessionEnd: [{ hooks: [{ type: 'command', command: 'echo "remember to hippo sleep your laptop"' }] }],
      },
    }, null, 2));
    const result = installOpencodePlugin();
    expect(result.migratedLegacyHooks).toBe(false);
    const after = JSON.parse(fs.readFileSync(opencodeJsonPath, 'utf8'));
    expect(after.hooks.SessionEnd).toHaveLength(1);
  });
});

describe('uninstallOpencodePlugin (real-FS)', () => {
  let env: { cleanup: () => void; home: string };
  beforeEach(() => { env = withFakeHome('hippo-opencode-'); });
  afterEach(() => { env.cleanup(); });

  it('removes only files with the hippo marker', () => {
    installOpencodePlugin();
    expect(uninstallOpencodePlugin()).toBe(true);
    expect(fs.existsSync(resolveOpencodePluginPath())).toBe(false);
  });

  it('returns false when plugin not installed', () => {
    expect(uninstallOpencodePlugin()).toBe(false);
  });

  it('refuses to delete a user-written hippo.ts without the marker', () => {
    const pluginPath = resolveOpencodePluginPath();
    fs.mkdirSync(path.dirname(pluginPath), { recursive: true });
    fs.writeFileSync(pluginPath, '// user-written content, no marker\n');
    expect(uninstallOpencodePlugin()).toBe(false);
    expect(fs.existsSync(pluginPath)).toBe(true);
  });

  it('ALSO runs the legacy-hooks migration (downgrade path)', () => {
    const opencodeJsonPath = path.join(env.home, '.config', 'opencode', 'opencode.json');
    fs.mkdirSync(path.dirname(opencodeJsonPath), { recursive: true });
    fs.writeFileSync(opencodeJsonPath, JSON.stringify({
      hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'hippo session-end --log-file x' }] }] },
    }, null, 2));
    // No plugin installed; uninstall should still clean the legacy block so a
    // user running `hippo hook uninstall opencode` to remove hippo entirely
    // leaves opencode launchable.
    expect(uninstallOpencodePlugin()).toBe(true);
    const after = JSON.parse(fs.readFileSync(opencodeJsonPath, 'utf8'));
    expect(after.hooks).toBeUndefined();
  });
});
```

**Step 2:** Run — FAIL on imports.

**Step 3: Implement** in `src/hooks.ts` after `uninstallJsonHooks`:

```typescript
export interface OpencodePluginInstallResult {
  installed: boolean;
  pluginPath: string;
  migratedLegacyHooks: boolean;
  jsonRepairFailed: boolean;
}

export function resolveOpencodePluginPath(): string {
  return path.join(homeDir(), '.config', 'opencode', 'plugins', 'hippo.ts');
}

function resolveOpencodeConfigPath(): string {
  return path.join(homeDir(), '.config', 'opencode', 'opencode.json');
}

/**
 * Return true iff a single hook entry's serialized form has a `command` string
 * that starts with `hippo ` (the verb-prefix). This is the same structural test
 * used by uninstallJsonHooks; substring matching against arbitrary user content
 * is unsafe (a user's `echo "remember to hippo sleep your laptop"` is not a
 * hippo-owned hook).
 */
function entryIsHippoOwned(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const hooks = (entry as { hooks?: unknown }).hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some((h) => {
    if (!h || typeof h !== 'object') return false;
    const cmd = (h as { command?: unknown }).command;
    return typeof cmd === 'string' && /^\s*hippo\s/.test(cmd);
  });
}

/**
 * Structurally strip every hippo-owned entry from opencode.json's hooks key.
 * Returns one of:
 *   { migrated: true,  jsonRepairFailed: false } — at least one entry removed.
 *   { migrated: false, jsonRepairFailed: false } — file fine, nothing to do.
 *   { migrated: false, jsonRepairFailed: true  } — file present but unparseable.
 *
 * When all hippo-owned entries are removed and a hook key becomes empty, that
 * key is deleted. When the top-level hooks object becomes empty it is deleted
 * too. Other keys (theme, etc.) are preserved.
 */
function migrateLegacyOpencodeHooksBlock(): { migrated: boolean; jsonRepairFailed: boolean } {
  const configPath = resolveOpencodeConfigPath();
  if (!fs.existsSync(configPath)) return { migrated: false, jsonRepairFailed: false };

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return { migrated: false, jsonRepairFailed: true };
  }

  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  if (!hooks || typeof hooks !== 'object') return { migrated: false, jsonRepairFailed: false };

  let changed = false;
  // Walk every event key (SessionEnd / SessionStart / UserPromptSubmit / Stop / etc.)
  // and remove hippo-owned entries surgically.
  for (const key of Object.keys(hooks)) {
    if (!Array.isArray(hooks[key])) continue;
    const before = hooks[key].length;
    hooks[key] = hooks[key].filter((entry) => !entryIsHippoOwned(entry));
    if (hooks[key].length !== before) {
      changed = true;
      if (hooks[key].length === 0) delete hooks[key];
    }
  }

  if (!changed) return { migrated: false, jsonRepairFailed: false };

  if (Object.keys(hooks).length === 0) delete settings.hooks;
  fs.writeFileSync(configPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return { migrated: true, jsonRepairFailed: false };
}

export function installOpencodePlugin(): OpencodePluginInstallResult {
  const pluginPath = resolveOpencodePluginPath();
  const { migrated, jsonRepairFailed } = migrateLegacyOpencodeHooksBlock();

  // Idempotence: skip the write only if BOTH the marker is present AND the
  // content matches the current source. Marker-only matches (with stale
  // content) overwrite cleanly so future patches reach existing installs.
  if (fs.existsSync(pluginPath)) {
    const existing = fs.readFileSync(pluginPath, 'utf8');
    if (existing.includes(HIPPO_OPENCODE_PLUGIN_MARKER) && existing === OPENCODE_PLUGIN_SOURCE) {
      return { installed: false, pluginPath, migratedLegacyHooks: migrated, jsonRepairFailed };
    }
  }
  fs.mkdirSync(path.dirname(pluginPath), { recursive: true });
  fs.writeFileSync(pluginPath, OPENCODE_PLUGIN_SOURCE, 'utf8');
  return { installed: true, pluginPath, migratedLegacyHooks: migrated, jsonRepairFailed };
}

export function uninstallOpencodePlugin(): boolean {
  const pluginPath = resolveOpencodePluginPath();
  let removedFile = false;
  if (fs.existsSync(pluginPath)) {
    const existing = fs.readFileSync(pluginPath, 'utf8');
    if (existing.includes(HIPPO_OPENCODE_PLUGIN_MARKER)) {
      fs.unlinkSync(pluginPath);
      removedFile = true;
    }
  }
  // Always run the legacy migration on uninstall — the downgrade path (user
  // removing hippo entirely) must leave opencode launchable.
  const { migrated } = migrateLegacyOpencodeHooksBlock();
  return removedFile || migrated;
}
```

**Step 4:** Run tests — expected 12 green.

**Step 5: Commit** `feat(hooks): add installOpencodePlugin + uninstallOpencodePlugin + structural opencode.json migration`.

---

## Task 3: Atomic refactor — narrow `JsonHookTarget`, flip detect, re-route CLI

**Files:**
- Modify: `src/hooks.ts` (lines 4-21 comment, line 28 type, lines 500-517 `resolveJsonHookPaths`, line 747 `detectInstalledTools`).
- Modify: `src/cli.ts` (lines 527, 4301, 4356, 4400-4421 jsonTools loop, 4444-4450 pluginTools loop, imports at 34-47).
- Modify: `tests/hooks.test.ts` (delete `describe('installJsonHooks(opencode)')` block at lines 231-257; change line ~355 `opencode kind === 'json-hook'` to `'plugin'`).
- Modify: `tests/opencode-plugin-install.test.ts` (add a `detectInstalledTools` assertion test for kind='plugin').

**This task is intentionally one commit** — the critic flagged Rev 0's 3-cut chain as un-bisectable. Doing the narrow + detect-flip + dispatch all in one atomic commit means every commit on the branch is green.

**Step 1: Edit `src/hooks.ts`**

- Lines 4-21: replace the file-header comment. New text describes claude-code uses JSON hooks; opencode uses a separate `installOpencodePlugin` code path. Keep migration-history bullets that still apply (Stop→SessionEnd, split SessionEnd) for the claude-code path.
- Line 28: `export type JsonHookTarget = 'claude-code';`
- Lines 500-517 `resolveJsonHookPaths`: drop the `'opencode'` case.
- Line 747: `{ name: 'opencode', configDir: '~/.config/opencode', detected: exists('.config', 'opencode'), kind: 'plugin', notes: 'installs a TS plugin at ~/.config/opencode/plugins/hippo.ts' },`

**Step 2: Edit `src/cli.ts`**

- Lines 34-47 import block: add `installOpencodePlugin`, `uninstallOpencodePlugin`, `resolveOpencodePluginPath` to the named imports.
- Line 527 (`hippo init` auto-install): the existing `if (hook === 'claude-code' || hook === 'opencode')` branch becomes `if (hook === 'claude-code')` for the JSON path, and a sibling `else if (hook === 'opencode')` block calls `installOpencodePlugin()` and logs accordingly.
- Lines 4301-4326 (`hippo hook install <target>`): same split. New log line for opencode includes the migration outcome ("Removed legacy Claude Code-style hooks block from opencode.json — opencode can now launch") when `migratedLegacyHooks` is true; warning when `jsonRepairFailed` is true ("opencode.json is unparseable; opencode plugin installed but the legacy hooks block could not be removed — fix the file manually").
- Lines 4356-4380 (`hippo hook uninstall <target>`): same split — claude-code → `uninstallJsonHooks('claude-code')`; opencode → `uninstallOpencodePlugin()`.
- Lines 4400-4421 (`hippo setup` jsonTools loop): leave the loop iterating claude-code-only json-hook tools (with the kind flip in Step 1, opencode no longer enters `jsonTools`). Update the no-tools message from "checked: claude-code, opencode" to "checked: claude-code" so it doesn't lie.
- Lines 4444-4450 (`hippo setup` pluginTools loop): patch the `for (const tool of pluginTools)` body — when `tool.name === 'opencode'` AND not dryRun, call `installOpencodePlugin()` and log the result the same way as the jsonTools loop. For other plugin tools (openclaw), keep the existing notes-only behavior. Dry-run prints "would install hippo plugin at ~/.config/opencode/plugins/hippo.ts".

**Step 3: Edit `tests/hooks.test.ts`**

- Delete lines 231-257 (the entire `describe('installJsonHooks(opencode)')` block — both tests are about JSON-hook semantics for opencode that no longer applies).
- Change line ~355 from `expect(tools.find((t) => t.name === 'opencode')?.kind).toBe('json-hook');` to `'plugin'`.

**Step 4: Add a detectInstalledTools test for opencode in `tests/opencode-plugin-install.test.ts`:**

```typescript
import { detectInstalledTools } from '../src/hooks.js';

describe('detectInstalledTools opencode entry', () => {
  let env: { cleanup: () => void; home: string };
  beforeEach(() => { env = withFakeHome('hippo-detect-'); });
  afterEach(() => { env.cleanup(); });

  it('marks opencode as kind:"plugin" with the plugin path in notes', () => {
    fs.mkdirSync(path.join(env.home, '.config', 'opencode'), { recursive: true });
    const tool = detectInstalledTools().find((t) => t.name === 'opencode');
    expect(tool?.kind).toBe('plugin');
    expect(tool?.notes).toContain('plugins/hippo.ts');
  });
});
```

**Step 5:** Run `npx tsc --noEmit && npm test`. Expected: clean tsc, full suite green.

**Step 6: Commit (one atomic commit covering Steps 1-4):**

```
fix(hooks): route opencode to plugin installer instead of JSON hooks (#24)

Narrows JsonHookTarget to 'claude-code' (compile-time guard so opencode
can't be re-introduced into the JSON installer). Updates the 5 CLI
dispatch sites in src/cli.ts including the previously-overlooked
pluginTools branch in cmdSetup. Flips detectInstalledTools to mark
opencode as kind:'plugin'. Deletes the now-stale
installJsonHooks(opencode) test block; updates the detectInstalledTools
assertion to expect 'plugin'. Adds a detectInstalledTools test in the
new opencode-plugin-install suite.

The single-commit shape is deliberate: a multi-commit split would leave
an intermediate commit with type errors (build broken) on the bisect
trail. Per the plan-eng-critic Rev 0 review.
```

---

## Task 4: README + CHANGELOG

**Files:** `README.md` (Framework Integrations table + any opencode mention), `CHANGELOG.md` (new 1.11.2 entry at top).

**Step 1:** `grep -n 'opencode\|OpenCode' README.md`. Update Framework Integrations table to say "installs a TS plugin at `~/.config/opencode/plugins/hippo.ts`".

**Step 2:** Prepend `## 1.11.2` entry to CHANGELOG. Content mirrors Rev 0 plan's CHANGELOG draft, with these additions:
- Note the structured error surface (`jsonRepairFailed`) on unparseable opencode.json.
- Note the `pluginTools` branch was overlooked in v1.10.x-v1.11.1 (the bug was wider than the original issue).
- Note `uninstall` now also runs the migration (downgrade-path safe).

**Commit** `docs: update README + CHANGELOG for v1.11.2 opencode plugin fix`.

---

## Task 5: Version bump

**Files:** `package.json`, `package-lock.json`, `src/version.ts`, `openclaw.plugin.json`, `extensions/openclaw-plugin/*.json`.

`grep -rEl '"version":\s*"1\.11\.1"' --include='*.json' --include='*.ts' . | grep -v node_modules` → bump each via targeted Edit. Run `npm run build:all && npm test; echo "exit=$?"`. Expected exit=0.

**Commit** `chore: bump version 1.11.1 → 1.11.2`.

---

## Verify stage (post-execute)

- `npm test; echo "exit=$?"` — both pass-summary AND exit=0 required.
- Manual smoke against tmp HOME:
  ```bash
  HIPPO_TEST_HOME=$(mktemp -d)
  HOME=$HIPPO_TEST_HOME node ./bin/hippo.js hook install opencode
  test -f $HIPPO_TEST_HOME/.config/opencode/plugins/hippo.ts
  test ! -f $HIPPO_TEST_HOME/.config/opencode/opencode.json
  ```
- Migration smoke (broken hooks block + unrelated user hook):
  ```bash
  mkdir -p $HIPPO_TEST_HOME/.config/opencode
  cat > $HIPPO_TEST_HOME/.config/opencode/opencode.json <<EOF
  {"theme":"dark","hooks":{"SessionEnd":[
    {"hooks":[{"type":"command","command":"hippo session-end --log-file foo"}]},
    {"hooks":[{"type":"command","command":"echo my-own-hook"}]}
  ]}}
  EOF
  HOME=$HIPPO_TEST_HOME node ./bin/hippo.js hook install opencode
  jq '.theme' $HIPPO_TEST_HOME/.config/opencode/opencode.json   # → "dark"
  jq '.hooks.SessionEnd | length' $HIPPO_TEST_HOME/.config/opencode/opencode.json   # → 1 (only my-own-hook survived)
  ```
- Unparseable-JSON smoke:
  ```bash
  echo '{ "hooks": [bad json' > $HIPPO_TEST_HOME/.config/opencode/opencode.json
  HOME=$HIPPO_TEST_HOME node ./bin/hippo.js hook install opencode 2>&1 | grep -i 'unparseable\|manual fix\|json'
  test -f $HIPPO_TEST_HOME/.config/opencode/plugins/hippo.ts   # plugin still installed
  ```

---

## Review stage

- `/self-review` on diff.
- `independent-review-critic`: brief on diff + plan + opencode docs URL; check the structural migration handles edge cases not covered by the 12 unit tests (e.g. a hooks key whose value is a string instead of an object, an array instead of object, etc.).
- `/review` per `feedback_hippo_release_workflow`.

---

## Ship stage

- `/ship-check`.
- `ship-readiness-critic`.
- `gh pr create` title `fix(hooks): opencode integration via plugin instead of JSON hooks (#24)`.
- Human-final-gate before `/publish-repo`.

---

## Deploy stage

- Merge + `/publish-repo` (npm publish + tag + GitHub Release).
- Close issue #24 with comment linking the merge commit + npm version.
- Smoke the npm tarball: `npm install -g hippo-memory@1.11.2 && hippo hook install opencode` in a fresh tmp dir.

---

## Success criteria (binary, verifiable) — REVISED for Rev 1

- [ ] `JsonHookTarget` narrowed to `'claude-code'`; `tsc --noEmit` clean.
- [ ] `installOpencodePlugin()` exported; writes plugin file with `HIPPO_OPENCODE_PLUGIN_V1` marker; returns `{ installed, pluginPath, migratedLegacyHooks, jsonRepairFailed }`.
- [ ] Plugin source has `typeof $ !== 'function'` guard; no `import type`; uses `.quiet().nothrow()` on every `$\`...\``.
- [ ] Idempotence keyed on marker AND content equality; stale-marker overwrites cleanly.
- [ ] Structural migration: only hippo-owned entries removed; non-hippo entries (including coincidental substring matches like `echo "remember to hippo sleep"`) preserved.
- [ ] `jsonRepairFailed=true` returned when opencode.json is unparseable; plugin install still succeeds.
- [ ] Empty hook-key arrays AND empty top-level hooks object are deleted (no `{ "hooks": {} }` litter).
- [ ] `detectInstalledTools` returns `kind: 'plugin'` for opencode with `notes` containing the plugin path.
- [ ] All 5 cli.ts dispatch sites route opencode to the plugin code path — including the previously-overlooked `pluginTools` branch in `cmdSetup` (cli.ts:4444).
- [ ] `hippo setup` against a host with opencode installs the plugin (not just prints notes).
- [ ] `uninstallOpencodePlugin()` also runs the legacy migration so downgrade leaves opencode launchable.
- [ ] `tests/_helpers/with-fake-home.ts` is the shared HOME-isolation helper; both `tests/hooks.test.ts` and `tests/opencode-plugin-install.test.ts` import it.
- [ ] tests/hooks.test.ts:231-257 `installJsonHooks(opencode)` block deleted; line ~355 assertion updated to `'plugin'`.
- [ ] Every commit on the branch is independently green (`npm test` and `tsc --noEmit` clean at each ref).
- [ ] Full test suite green (1599+ tests, exit code 0) at branch tip.
- [ ] Manual smoke + migration smoke + unparseable-JSON smoke pass.
- [ ] CHANGELOG 1.11.2 entry includes the root-cause analysis + the jsonRepairFailed surface + the pluginTools branch oversight + the uninstall-also-migrates note.
- [ ] Version 1.11.2 in package.json + lockfile + src/version.ts + openclaw manifests.
- [ ] PR opened, all critics pass, human gate clears, merged to master.
- [ ] npm @latest tag points to 1.11.2.
- [ ] Issue #24 closed.

---

## Out of scope (deliberate)

- **Pinned-context auto-injection on opencode.** No clean per-prompt-submit event. Future release.
- **Adding more opencode events** (file.edited, tool.execute.after, etc.) — outside #24's scope.
- **Per-project `.opencode/plugins/hippo.ts`** — hippo is cross-project by design.
- **Refactoring the codex wrapper / openclaw plugin code paths** — correct for their respective tools.
