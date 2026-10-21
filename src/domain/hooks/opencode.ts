// The OpenCode plugin hippo installs and the hippo hooks it strips from an old opencode.json; surface/hooks-install
// does the reads and writes.
import * as path from 'path';
import { homeDir } from '../../base/util/agent-homes.js';
import { type JsonValue, isJsonString, isJsonObjectLiteral } from '../../base/util/json.js';

const HIPPO_OPENCODE_PLUGIN_MARKER = 'HIPPO_OPENCODE_PLUGIN_V1';

/**
 * The opencode plugin installed at ~/.config/opencode/plugins/hippo.ts: session.idle runs `hippo session-end`,
 * session.created runs `hippo last-sleep`.
 * No `@opencode-ai/plugin` type import (unresolved, it would crash the loader); `$` is guarded and `.nothrow()` keeps a
 * missing hippo binary from throwing.
 */
export const OPENCODE_PLUGIN_SOURCE = `// ${HIPPO_OPENCODE_PLUGIN_MARKER}
// hippo-memory opencode plugin. DO NOT EDIT — regenerated on every
// \`hippo hook install opencode\` from src/domain/hooks/opencode.ts OPENCODE_PLUGIN_SOURCE
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
          const r = await $\`hippo session-end\`.quiet().nothrow();
          if (r && r.exitCode !== 0) console.error("[hippo] session-end exited " + r.exitCode);
        } else if (event.type === "session.created") {
          const r = await $\`hippo last-sleep\`.quiet().nothrow();
          if (r && r.exitCode !== 0) console.error("[hippo] last-sleep exited " + r.exitCode);
        }
      } catch (err) {
        // hippo CLI not on PATH or other failure: never crash the host session.
        console.error("[hippo] plugin hook failed: " + (err && err.message ? err.message : err));
      }
    },
  };
};
`;

export { HIPPO_OPENCODE_PLUGIN_MARKER };

// OpenCode plugin installer. OpenCode's config has `additionalProperties: false` and no `hooks` key, so a JSON-hook
// install breaks its launch: write a TS plugin, migrate any old hooks block out.

export interface OpencodePluginInstallResult {
  installed: boolean;
  pluginPath: string;
  migratedLegacyHooks: boolean;
  jsonRepairFailed: boolean;
}

export function resolveOpencodePluginPath(): string {
  return path.join(homeDir(), '.config', 'opencode', 'plugins', 'hippo.ts');
}

export function resolveOpencodeConfigPath(): string {
  return path.join(homeDir(), '.config', 'opencode', 'opencode.json');
}

/**
 * True iff a hook entry's command starts with `hippo ` plus a verb hippo itself installs (session-end, last-sleep,
 * sleep, capture, context).
 * Structural, not substring (`echo "remember to hippo sleep"` is not ours), and per hook so user-authored hooks in the
 * same entry survive.
 */
const HIPPO_OWNED_COMMAND_RE = /^\s*hippo\s+(session-end|last-sleep|sleep|capture|context)(?=\s|$)/;

function hookIsHippoOwned(hook: JsonValue | undefined): boolean {
  if (!isJsonObjectLiteral(hook)) return false;
  const cmd = hook.command;
  return isJsonString(cmd) && HIPPO_OWNED_COMMAND_RE.test(cmd);
}

/** Strips every hippo-owned hook from parsed opencode.json, edited in place, deleting entries, keys and the `hooks`
 * object as they empty; true when anything changed. A non-object `hooks` is user content hippo does not recognise. */
export function stripLegacyHooks(settings: JsonValue): boolean {
  if (!isJsonObjectLiteral(settings)) return false;
  const hooksObj = settings.hooks;
  if (!isJsonObjectLiteral(hooksObj)) return false;
  let changed = false;
  for (const key of Object.keys(hooksObj)) {
    const entries = hooksObj[key];
    if (!Array.isArray(entries)) continue;
    const { survivingEntries, strippedAny } = stripHippoHooksFromEntries(entries);
    if (strippedAny || survivingEntries.length !== entries.length) changed = true;
    hooksObj[key] = survivingEntries;
    if (survivingEntries.length === 0) delete hooksObj[key];
  }
  if (changed && Object.keys(hooksObj).length === 0) delete settings.hooks;
  return changed;
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

/** True when the file is hippo's plugin as this release writes it, so install can skip the write. */
export function isCurrentPlugin(text: string): boolean {
  return text.includes(HIPPO_OPENCODE_PLUGIN_MARKER) && text === OPENCODE_PLUGIN_SOURCE;
}
