// Which agent tools this machine has, read from their config folders; `hippo setup` picks its
// installs from it.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { claudeConfigDir, codexHomeDir, vscodeDataFolders } from '../../base/util/agent-homes.js';
import { homeDir, processHomes } from '../../host/agent-homes.js';
import { copilotHomeDir, type ToolDetection } from './rules/shared.js';

/** Codex counts as installed only when its config folder exists: Codex itself refuses a
 * CODEX_HOME that is not a folder. */
export function isCodexPresent(home: string = homeDir()): boolean {
  return (
    fs
      .statSync(codexHomeDir(home, processHomes().env), { throwIfNoEntry: false })
      ?.isDirectory() === true
  );
}

/** The VS Code User folders that exist; Stable and Insiders keep their own, and only an edition
 * the user has run has one. */
export function vscodeUserDirs(
  env: Readonly<Record<string, string | undefined>> = processHomes().env,
  home: string = os.homedir(),
): string[] {
  return vscodeDataFolders({ env, home, platform: process.platform })
    .map((dir) => path.join(dir, 'User'))
    .filter((dir) => fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory() === true);
}

/** Copilot counts as installed only when its config folder or a VS Code User folder exists, so
 * setup never creates ~/.copilot on a machine with neither. */
export function isCopilotPresent(home: string = os.homedir()): boolean {
  return (
    fs
      .statSync(copilotHomeDir({ home, env: processHomes().env }), { throwIfNoEntry: false })
      ?.isDirectory() === true || vscodeUserDirs(processHomes().env, home).length > 0
  );
}

const COPILOT_NOTES =
  'hooks in hooks/hippo.json, the MCP server in mcp-config.json and a block in copilot-instructions.md; for VS ' +
  'Code, the server in each User mcp.json and prompts/hippo.instructions.md';

/** Detect which AI coding tools are installed from config directory presence; `hippo setup` uses
 * it to pick JSON-hook installs. */
export function detectInstalledTools(): ToolDetection[] {
  const home = homeDir();
  const exists = (...parts: string[]) => fs.existsSync(path.join(home, ...parts));
  return [...detectClaudeToCodex(home, exists), ...detectCopilotToPi(exists)];
}

type HomeHas = (...parts: string[]) => boolean;

/** Claude Code, the two plugin hosts and Codex, in setup's order. */
function detectClaudeToCodex(home: string, exists: HomeHas): ToolDetection[] {
  const claudeDir = claudeConfigDir(os.homedir(), processHomes().env);
  return [
    {
      name: 'claude-code',
      configDir: claudeDir,
      detected: fs.existsSync(claudeDir),
      kind: 'json-hook',
    },
    {
      name: 'opencode',
      configDir: '~/.config/opencode',
      detected: exists('.config', 'opencode'),
      kind: 'plugin',
      notes: 'installs a TS plugin at ~/.config/opencode/plugins/hippo.ts',
    },
    {
      name: 'openclaw',
      configDir: '~/.openclaw',
      detected: exists('.openclaw'),
      kind: 'plugin',
      notes: 'install via `openclaw plugins install hippo-memory`',
    },
    {
      name: 'codex',
      configDir: '~/.codex',
      detected: isCodexPresent(home),
      kind: 'wrapper',
      notes:
        'memory hooks in hooks.json, and wraps the detected codex launcher for session-end consolidation',
    },
  ];
}

/** Copilot and the two tools with no hook API, in setup's order. */
function detectCopilotToPi(exists: HomeHas): ToolDetection[] {
  return [
    {
      name: 'copilot',
      configDir: copilotHomeDir(processHomes()),
      detected: isCopilotPresent(),
      kind: 'json-hook',
      notes: COPILOT_NOTES,
    },
    {
      name: 'cursor',
      configDir: '~/.cursor',
      detected: exists('.cursor'),
      kind: 'markdown-instruction',
      notes: 'no hook API - patches AGENTS.md in the project',
    },
    {
      name: 'pi',
      configDir: '~/.pi',
      detected: exists('.pi'),
      kind: 'markdown-instruction',
      notes: 'no hook API - patches AGENTS.md in the project',
    },
  ];
}
