import * as fs from 'fs';
import * as path from 'path';
import type { JsonObject } from '../working-memory.js';
import { isJsonObject, homeDir } from './shared.js';
import { type JsonValue, isJsonString } from '../json.js';

const HIPPO_OPENCODE_PLUGIN_MARKER = 'HIPPO_OPENCODE_PLUGIN_V1';

/**
 * The opencode plugin file we install at ~/.config/opencode/plugins/hippo.ts.
 *
 * Per https://opencode.ai/docs/plugins/, plugins are TS/JS modules exporting an
 * async function returning hooks. We subscribe to `event` and route:
 *   session.idle    → `hippo session-end` (Claude Code's SessionEnd equiv)
 *   session.created → `hippo last-sleep` (Claude Code's SessionStart equiv)
 *
 * Design choices:
 *
 * 1. No `import type { Plugin } from "@opencode-ai/plugin"`. The package's npm
 *    publication status was unverifiable from the build sandbox (npmjs.com
 *    returned 403); an unresolved type-only import would still crash the TS
 *    runtime opencode uses to load the plugin. opencode infers plugin shape
 *    from the returned object, so the type was convenience-only.
 *
 * 2. Defensive `typeof $ !== 'function'` guard. opencode runs in Bun (where
 *    `$` is the shell-template helper), but a future Node-mode deployment
 *    would have `$` undefined in the destructured context and the plugin
 *    would throw on every session.idle, killing opencode sessions in a
 *    hard-to-recover way (the idempotence marker prevents auto-reinstall).
 *    Fail closed, let opencode continue.
 *
 * 3. `.quiet().nothrow()` on each `$\`...\`` so a missing hippo binary
 *    (e.g. PATH-misconfigured user) does NOT throw out of the event handler.
 *    The surrounding try/catch is belt-and-braces.
 *
 * 4. UserPromptSubmit equivalent NOT wired. opencode's `message.updated`
 *    fires per-token, not per-prompt-submit; no clean per-prompt event.
 *    Users wanting pinned-context auto-injection can call `hippo context`
 *    via the MCP server (`hippo mcp`).
 *
 * 5. Versioned marker `HIPPO_OPENCODE_PLUGIN_V1` allows future versions to
 *    overwrite cleanly. The installer's idempotence check requires BOTH
 *    marker match AND content equality, so a plugin-source revision under
 *    the same V1 marker re-writes the file on next install.
 */
export const OPENCODE_PLUGIN_SOURCE = `// ${HIPPO_OPENCODE_PLUGIN_MARKER}
// hippo-memory opencode plugin. DO NOT EDIT — regenerated on every
// \`hippo hook install opencode\` from src/hooks.ts OPENCODE_PLUGIN_SOURCE
// in https://github.com/kitfunso/hippo-memory. Local changes will be lost.

export const HippoPlugin = async ({ $ }) => {
  return {
    event: async ({ event }) => {
      // Defense in depth: opencode currently runs in Bun where $ is the shell
      // template helper. A non-Bun runtime would have $ as undefined; fail
      // closed instead of crashing the host session.
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

// OpenCode plugin installer. OpenCode's config has `additionalProperties: false` and no `hooks` key,
// so a JSON-hook install breaks its launch: write a TS plugin, migrate any old hooks block out.

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
 * Return true iff a single hook-array entry's command string starts with
 * `hippo ` (the verb-prefix). Used to surgically remove only hippo-owned
 * commands when migrating an opencode.json. We own the install side, so only
 * the canonical `hippo <verb>` form needs to match — and only canonical verbs
 * hippo itself installs (session-end, last-sleep, sleep, capture, context),
 * not any third-party tool that happens to be named `hippo`.
 *
 * Structural check: substring matching against
 * arbitrary user content is unsafe — a user's
 * `echo "remember to hippo sleep your laptop"` is not a hippo-owned hook.
 *
 * Per-hook (not per-entry) granularity: an entry whose inner
 * hooks array mixes hippo-installed commands with user-authored commands
 * must NOT lose the user-authored commands. The migration filters the inner
 * array per-hook, then drops the entry only when its inner array is empty.
 */
const HIPPO_OWNED_COMMAND_RE = /^\s*hippo\s+(session-end|last-sleep|sleep|capture|context)(?=\s|$)/;

function hookIsHippoOwned(hook: JsonValue | undefined): boolean {
  if (!isJsonObject(hook)) return false;
  const cmd = hook.command;
  return isJsonString(cmd) && HIPPO_OWNED_COMMAND_RE.test(cmd);
}

/**
 * Structurally strip every hippo-owned hook from opencode.json's hooks key.
 * Returns one of:
 *   { migrated: true,  jsonRepairFailed: false } — at least one hook removed.
 *   { migrated: false, jsonRepairFailed: false } — file fine, nothing to do.
 *   { migrated: false, jsonRepairFailed: true  } — file present but unparseable.
 *
 * Per-hook surgery:
 *   - For each entry in each event-key array, filter the inner `hooks` array
 *     to remove hippo-owned hooks only. User-authored hooks in the same
 *     inner array are preserved.
 *   - When an entry's inner `hooks` array becomes empty, that entry is
 *     removed from the outer array.
 *   - When an event-key array becomes empty, the key is deleted.
 *   - When the top-level `hooks` object becomes empty, it is deleted.
 *   - Other keys (theme, etc.) are always preserved.
 */
function migrateLegacyOpencodeHooksBlock() {
  const configPath = resolveOpencodeConfigPath();
  if (!fs.existsSync(configPath)) return { migrated: false, jsonRepairFailed: false };

  let settings: JsonObject;
  try {
    settings = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return { migrated: false, jsonRepairFailed: true };
  }

  const hooks = settings.hooks;
  // Non-object hooks values (string, array, null) are user content we don't
  // recognise — leave them alone, return migrated=false.
  if (!isJsonObject(hooks)) {
    return { migrated: false, jsonRepairFailed: false };
  }

  const hooksObj = hooks;
  let changed = false;
  for (const key of Object.keys(hooksObj)) {
    if (!Array.isArray(hooksObj[key])) continue;
    const survivingEntries: JsonValue[] = [];
    for (const entry of hooksObj[key]) {
      if (!isJsonObject(entry)) {
        survivingEntries.push(entry);
        continue;
      }
      const innerHooks = entry.hooks;
      if (!Array.isArray(innerHooks)) {
        survivingEntries.push(entry);
        continue;
      }
      const beforeInner = innerHooks.length;
      const survivingInner = innerHooks.filter((h) => !hookIsHippoOwned(h));
      if (survivingInner.length !== beforeInner) changed = true;
      if (survivingInner.length === 0) continue; // drop entry, nothing left
      entry.hooks = survivingInner;
      survivingEntries.push(entry);
    }
    if (survivingEntries.length !== hooksObj[key].length) changed = true;
    hooksObj[key] = survivingEntries;
    if (hooksObj[key].length === 0) delete hooksObj[key];
  }

  if (!changed) return { migrated: false, jsonRepairFailed: false };

  if (Object.keys(hooksObj).length === 0) delete settings.hooks;
  fs.writeFileSync(configPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return { migrated: true, jsonRepairFailed: false };
}

export function installOpencodePlugin(): OpencodePluginInstallResult {
  const pluginPath = resolveOpencodePluginPath();
  const { migrated, jsonRepairFailed } = migrateLegacyOpencodeHooksBlock();

  // Idempotence: skip the write only if BOTH the marker is present AND the
  // content matches the current source. Marker-only matches (with stale
  // content) overwrite cleanly so future plugin-source patches reach
  // existing installs.
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
