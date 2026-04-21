import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureCodexWrapperInstalled } from './hooks.js';

function main(): void {
  if (process.env.HIPPO_SKIP_POSTINSTALL === '1') return;

  try {
    ensureCodexWrapperInstalled();
  } catch {
    // Never fail package install because auto-integration could not be applied.
  }

  try {
    printClaudeCodeNudge();
  } catch {
    // Never fail package install because the install hint could not be printed.
  }
}

/**
 * Read-only nudge: if Claude Code is detected on the machine and the Hippo
 * UserPromptSubmit hook is NOT yet installed, print a short message pointing
 * the user at `hippo init`. No config writes. Silent otherwise.
 *
 * We avoid aggressively auto-patching ~/.claude/settings.json from a package
 * postinstall — that's surprising, breaks the principle of least authority,
 * and trips security scanners. A one-line visible prompt is the friendly
 * middle ground.
 */
function printClaudeCodeNudge(): void {
  const home = os.homedir();
  const claudeDir = path.join(home, '.claude');
  if (!fs.existsSync(claudeDir)) return; // Claude Code not installed — silent

  const settingsPath = path.join(claudeDir, 'settings.json');
  if (fs.existsSync(settingsPath)) {
    try {
      const raw = fs.readFileSync(settingsPath, 'utf8');
      if (raw.includes('hippo context --pinned-only')) return; // already installed
    } catch {
      // Fall through: on read failure, still show the nudge — a broken
      // settings.json is a bigger problem for the user to see.
    }
  }

  // Use stderr so the banner doesn't get piped into scripts reading package
  // output on stdout.
  const line = (s: string) => process.stderr.write(s + '\n');
  line('');
  line('hippo-memory installed. Claude Code detected on this machine.');
  line('');
  line('To wire Hippo into Claude Code (session hooks + mid-session pinned');
  line('rule re-injection), run ONE of these in your project directory:');
  line('');
  line('    hippo init                  # initialize + install hooks for this project');
  line('    hippo hook install claude-code   # hooks only, no local store');
  line('');
  line('Or machine-wide pinned memories:');
  line('');
  line('    hippo init --global');
  line('');
  line('To skip this message on future installs: export HIPPO_SKIP_POSTINSTALL=1');
  line('');
}

main();
