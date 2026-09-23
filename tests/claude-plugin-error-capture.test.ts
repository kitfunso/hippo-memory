import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../extensions/claude-code-plugin/scripts/capture-error.sh', import.meta.url));

interface FailurePayload {
  hook_event_name?: string;
  tool_name: string;
  tool_input?: { command: string };
  error: string;
  is_interrupt: boolean;
}

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

  function runHook(stdin: string): string {
    const result = spawnSync('bash', [SCRIPT], {
      cwd: dir,
      input: stdin,
      env: {
        ...process.env,
        PATH: [dir, path.dirname(process.execPath), process.env.PATH].join(path.delimiter),
        HIPPO_STUB_OUT: argsFile,
      },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    return result.stderr;
  }

  it('remembers the failed tool and its error from the stdin payload', () => {
    runHook(JSON.stringify({
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      error: "Exit code 1\nError: Cannot find module 'express'",
      is_interrupt: false,
    } satisfies FailurePayload));
    expect(fs.readFileSync(argsFile, 'utf8').trim().split('\n')).toEqual([
      'remember',
      "Bash: Exit code 1 Error: Cannot find module 'express'",
      '--error',
      '--tag',
      'auto-captured',
    ]);
  });

  it('skips interrupts', () => {
    runHook(JSON.stringify({ tool_name: 'Bash', error: 'Interrupted by user', is_interrupt: true } satisfies FailurePayload));
    expect(fs.existsSync(argsFile)).toBe(false);
  });

  it('says so in one line, with no stack trace, when the payload is not a JSON object', () => {
    for (const bad of ['not json', 'null', '42']) {
      const stderr = runHook(bad);
      expect(stderr.trim().split('\n'), bad).toEqual(['hippo: capture-error hook got a payload that is not a JSON object']);
      expect(fs.existsSync(argsFile)).toBe(false);
    }
  });
});
