// The hippo-memory/json-hooks subpath: only what the changelog publishes, so the module's other exports stay internal.
export { resolveJsonHookPaths, type InstallResult, type JsonHookPaths } from '../domain/hooks/json-hooks.js';
export { installJsonHooks, uninstallJsonHooks, writeSettingsFile } from '../surface/hooks-install/json-hooks.js';
export { readJsonFile } from '../base/util/json.js';
