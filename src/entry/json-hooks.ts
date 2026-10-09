// The hippo-memory/json-hooks subpath: only what the changelog publishes, so the module's other exports stay internal.
export { installJsonHooks, resolveJsonHookPaths, uninstallJsonHooks, writeSettingsFile, type InstallResult, type JsonHookPaths } from '../hooks/json-hooks.js';
export { readJsonFile } from '../util/json.js';
