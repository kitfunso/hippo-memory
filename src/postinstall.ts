import { envSkipPostinstall } from './util/env.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectRealCodexPath, isCodexWrapperInstalled, repairCodexWrapperIfInstalled } from './hooks/codex-wrapper.js';
import { claudeConfigDir } from './util/agent-homes.js';
import { errorMessage, log } from './util/log.js';

function main(): void {
  if (envSkipPostinstall()) return;

  try {
    // Repair-only, for users who opted in (a Codex update can restore the real binary over our shim): swapping the binary from postinstall
    // is a consent violation that supply-chain scanners read as hijacking, so first install is `hippo hook install codex` only.
    repairCodexWrapperIfInstalled();
  } catch (err) {
    // Never fail package install because auto-integration could not be applied.
    log.debug(`postinstall: codex wrapper not repaired: ${errorMessage(err)}`);
  }

  try {
    printClaudeCodeNudge();
  } catch {
    // Never fail package install because the install hint could not be printed.
  }

  try {
    printCodexNudge();
  } catch {
    // Never fail package install because the install hint could not be printed.
  }
}

/** Read-only nudge: if Claude Code is detected and the Hippo UserPromptSubmit hook is not installed, point the user at `hippo init`.
 * It never patches ~/.claude/settings.json from a package postinstall: surprising, against least authority, and trips security scanners. */
function printClaudeCodeNudge(): void {
  const claudeDir = claudeConfigDir(os.homedir());
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

/** Read-only nudge: if the Codex CLI is on PATH and the session-capture wrapper is not installed, print the opt-in command;
 * same least-authority reasoning as the Claude Code nudge, we never swap the user's binary. */
function printCodexNudge(): void {
  if (isCodexWrapperInstalled()) return;
  if (!detectRealCodexPath()) return; // Codex not installed — silent

  const line = (s: string) => process.stderr.write(s + '\n');
  line('');
  line('Codex CLI detected on this machine.');
  line('');
  line('To capture Codex sessions into Hippo (wraps the codex launcher;');
  line('undo anytime with `hippo hook uninstall codex`), run:');
  line('');
  line('    hippo hook install codex');
  line('');
}

main();
