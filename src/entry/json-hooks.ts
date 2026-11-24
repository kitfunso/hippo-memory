export {
  type InstallResult,
  type JsonHookPaths,
} from '../surface/hooks-install/rules/json-hooks.js';
export {
  installJsonHooks,
  resolveJsonHookPaths,
  uninstallJsonHooks,
  writeSettingsFile,
} from '../surface/hooks-install/json-hooks.js';
export { readJsonFile } from '../host/json-file.js';
