// The hippo-memory/json-hooks subpath: only what the changelog publishes, so the module's other exports stay internal.
export { type InstallResult, type JsonHookPaths } from '../domain/hooks/json-hooks.js';
export {
  installJsonHooks,
  resolveJsonHookPaths,
  uninstallJsonHooks,
  writeSettingsFile,
} from '../surface/hooks-install/json-hooks.js';
export { readJsonFile } from '../host/json-file.js';
