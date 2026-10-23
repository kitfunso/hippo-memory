// Writes and removes hippo's OpenCode plugin, and takes an old JSON hooks block out of opencode.json, which OpenCode's
// schema rejects.
import * as fs from 'node:fs';
import { writeFileAtomic } from '../../host/atomic-write.js';
import { tryReadJsonFile } from '../../host/json-file.js';
import {
  HIPPO_OPENCODE_PLUGIN_MARKER,
  isCurrentPlugin,
  OPENCODE_PLUGIN_SOURCE,
  opencodeConfigPathOn,
  opencodePluginPathOn,
  stripLegacyHooks,
  type OpencodePluginInstallResult,
} from '../../domain/hooks/opencode.js';
import { processHomes } from '../../host/agent-homes.js';

// The installer module exposes the path it installs to.
/** Where hippo's OpenCode plugin lives under this process's home folder. */
export function resolveOpencodePluginPath(): string {
  return opencodePluginPathOn(processHomes());
}

/** `jsonRepairFailed`: opencode.json is there but does not parse, so it was left alone. */
function migrateLegacyOpencodeHooksBlock() {
  const configPath = opencodeConfigPathOn(processHomes());
  if (!fs.existsSync(configPath)) return { migrated: false, jsonRepairFailed: false };
  const settings = tryReadJsonFile(configPath);
  if (settings === undefined) return { migrated: false, jsonRepairFailed: true };
  if (!stripLegacyHooks(settings)) return { migrated: false, jsonRepairFailed: false };
  writeFileAtomic(configPath, JSON.stringify(settings, null, 2) + '\n');
  return { migrated: true, jsonRepairFailed: false };
}

export function installOpencodePlugin(): OpencodePluginInstallResult {
  const pluginPath = resolveOpencodePluginPath();
  const { migrated, jsonRepairFailed } = migrateLegacyOpencodeHooksBlock();
  // A marker-only match with stale content is rewritten, so plugin-source patches reach existing installs.
  if (fs.existsSync(pluginPath) && isCurrentPlugin(fs.readFileSync(pluginPath, 'utf8'))) {
    return { installed: false, pluginPath, migratedLegacyHooks: migrated, jsonRepairFailed };
  }
  writeFileAtomic(pluginPath, OPENCODE_PLUGIN_SOURCE);
  return { installed: true, pluginPath, migratedLegacyHooks: migrated, jsonRepairFailed };
}

export function uninstallOpencodePlugin(): boolean {
  const pluginPath = resolveOpencodePluginPath();
  let removedFile = false;
  if (fs.existsSync(pluginPath) && fs.readFileSync(pluginPath, 'utf8').includes(HIPPO_OPENCODE_PLUGIN_MARKER)) {
    fs.unlinkSync(pluginPath);
    removedFile = true;
  }
  // The legacy migration runs on uninstall too: a user removing hippo entirely must be left with a launchable opencode.
  const { migrated } = migrateLegacyOpencodeHooksBlock();
  return removedFile || migrated;
}
