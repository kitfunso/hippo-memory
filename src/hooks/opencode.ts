import * as fs from 'fs';
import * as path from 'path';
import type { JsonObject } from '../store/working-memory.js';
import { homeDir } from '../util/agent-homes.js';
import { writeFileAtomic } from '../util/atomic-write.js';
import { type JsonValue, isJsonString, isJsonObjectLiteral } from '../util/json.js';

const HIPPO_OPENCODE_PLUGIN_MARKER = 'HIPPO_OPENCODE_PLUGIN_V1';

/** The opencode plugin installed at ~/.config/opencode/plugins/hippo.ts: session.idle runs `hippo session-end`, session.created runs `hippo last-sleep`.
 * No `@opencode-ai/plugin` type import (unresolved, it would crash the loader); `$` is guarded and `.nothrow()` keeps a missing hippo binary from throwing. */
const OPENCODE_PLUGIN_SOURCE = `// ${HIPPO_OPENCODE_PLUGIN_MARKER}
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

/** True iff a hook entry's command starts with `hippo ` plus a verb hippo itself installs (session-end, last-sleep, sleep, capture, context).
 * Structural, not substring (`echo "remember to hippo sleep"` is not ours), and per hook so user-authored hooks in the same entry survive. */
const HIPPO_OWNED_COMMAND_RE = /^\s*hippo\s+(session-end|last-sleep|sleep|capture|context)(?=\s|$)/;

function hookIsHippoOwned(hook: JsonValue | undefined): boolean {
  if (!isJsonObjectLiteral(hook)) return false;
  const cmd = hook.command;
  return isJsonString(cmd) && HIPPO_OWNED_COMMAND_RE.test(cmd);
}

/** Strip every hippo-owned hook from opencode.json's `hooks` key, deleting entries, keys and the object as they empty; user-authored hooks and other keys stay.
 * Returns `{ migrated, jsonRepairFailed }`; jsonRepairFailed means the file is present but unparseable. */
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
  if (!isJsonObjectLiteral(hooks)) {
    return { migrated: false, jsonRepairFailed: false };
  }

  const hooksObj = hooks;
  let changed = false;
  for (const key of Object.keys(hooksObj)) {
    if (!Array.isArray(hooksObj[key])) continue;
    const { survivingEntries, strippedAny } = stripHippoHooksFromEntries(hooksObj[key]);
    if (strippedAny) changed = true;
    if (survivingEntries.length !== hooksObj[key].length) changed = true;
    hooksObj[key] = survivingEntries;
    if (hooksObj[key].length === 0) delete hooksObj[key];
  }

  if (!changed) return { migrated: false, jsonRepairFailed: false };

  if (Object.keys(hooksObj).length === 0) delete settings.hooks;
  writeFileAtomic(configPath, JSON.stringify(settings, null, 2) + '\n');
  return { migrated: true, jsonRepairFailed: false };
}

/** One event's entries with every hippo-owned hook taken out, and whether any was. */
function stripHippoHooksFromEntries(entries: JsonValue[]) {
  const survivingEntries: JsonValue[] = [];
  let strippedAny = false;
  for (const entry of entries) {
    if (!isJsonObjectLiteral(entry)) {
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
    if (survivingInner.length !== beforeInner) strippedAny = true;
    if (survivingInner.length === 0) continue; // drop entry, nothing left
    entry.hooks = survivingInner;
    survivingEntries.push(entry);
  }
  return { survivingEntries, strippedAny };
}

export function installOpencodePlugin(): OpencodePluginInstallResult {
  const pluginPath = resolveOpencodePluginPath();
  const { migrated, jsonRepairFailed } = migrateLegacyOpencodeHooksBlock();

  // Skip the write only if BOTH the marker is present and the content matches; a marker-only match with stale
  // content is rewritten so plugin-source patches reach existing installs.
  if (fs.existsSync(pluginPath)) {
    const existing = fs.readFileSync(pluginPath, 'utf8');
    if (existing.includes(HIPPO_OPENCODE_PLUGIN_MARKER) && existing === OPENCODE_PLUGIN_SOURCE) {
      return { installed: false, pluginPath, migratedLegacyHooks: migrated, jsonRepairFailed };
    }
  }
  writeFileAtomic(pluginPath, OPENCODE_PLUGIN_SOURCE);
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
