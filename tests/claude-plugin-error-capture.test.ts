import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../extensions/claude-code-plugin/scripts/capture-error.sh', import.meta.url));

// Windows runners can resolve `bash` to the WSL launcher; Claude Code runs this script under sh or Git Bash.
describe.skipIf(process.platform === 'win32')('Claude Code plugin error capture', () => {
  let dir: string;
  let argsFile: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-capture-error-'));
    argsFile = path.join(dir, 'args.txt');
    fs.writeFileSync(path.join(dir, 'hippo'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$HIPPO_STUB_OUT"\n', { mode: 0o755 });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function runHook(payload: Record<string, unknown>): void {
    const result = spawnSync('bash', [SCRIPT], {
      cwd: dir,
      input: JSON.stringify(payload),
      env: {
        ...process.env,
        PATH: [dir, path.dirname(process.execPath), process.env.PATH].join(path.delimiter),
        HIPPO_STUB_OUT: argsFile,
      },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
  }

  it('remembers the failed tool and its error from the stdin payload', () => {
    runHook({
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      error: "Exit code 1\nError: Cannot find module 'express'",
      is_interrupt: false,
    });
    expect(fs.readFileSync(argsFile, 'utf8').trim().split('\n')).toEqual([
      'remember',
      "Bash: Exit code 1 Error: Cannot find module 'express'",
      '--error',
      '--tag',
      'auto-captured',
    ]);
  });

  it('skips interrupts', () => {
    runHook({ tool_name: 'Bash', error: 'Interrupted by user', is_interrupt: true });
    expect(fs.existsSync(argsFile)).toBe(false);
  });
});
