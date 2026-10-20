// The Codex wrapper forwards user arguments through cmd.exe to a .cmd shim; cmd expands
// %VAR% even inside double quotes, so an argument must reach the program byte for byte.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { cmdShimArgs, quoteCmdArg, spawnArgv } from '../../src/base/util/spawn-argv.js';

const TRICKY_ARGS = [
  '%PATH%',
  '100%',
  '%%',
  '%cd%',
  'p%USERNAME%q r',
  '%cd:~,%',
  '%PATH:~0,3%',
  '%"PATH"^%',
  'a b',
  'x"y',
  '"',
  '""',
  'a&b',
  '"&calc',
  '^%PATH^%',
  '!PATH!',
  '',
];

describe('quoteCmdArg', () => {
  it('never leaves a %NAME% pair for cmd.exe to expand', () => {
    expect(quoteCmdArg('%PATH%')).not.toMatch(/%PATH%/);
    expect(quoteCmdArg('100%')).not.toBe('100%');
  });

  it.each(['a\nb', 'a\rb', 'x\r\ncalc'])('refuses an argument holding a line break (%j)', (arg) => {
    expect(() => quoteCmdArg(arg)).toThrow(/CR or LF/);
    expect(() => cmdShimArgs('C:/bin/tool.cmd', [arg])).toThrow(/CR or LF/);
  });

  it('leaves a plain argument unquoted', () => {
    expect(quoteCmdArg('--model')).toBe('--model');
  });

  describe.skipIf(process.platform !== 'win32')('through cmd.exe and a .cmd shim', () => {
    let dir: string;

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'hippo-cmd-quote-'));
      writeFileSync(join(dir, 'print.js'), 'console.log(JSON.stringify(process.argv.slice(2)));\n');
      writeFileSync(join(dir, 'shim.cmd'), '@node "%~dp0print.js" %*\r\n');
    });

    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('delivers every argument unexpanded', () => {
      const r = spawnSync('cmd.exe', cmdShimArgs(join(dir, 'shim.cmd'), TRICKY_ARGS), {
        windowsVerbatimArguments: true,
        encoding: 'utf8',
      });
      expect(r.stderr).toBe('');
      expect(JSON.parse(r.stdout.trim())).toEqual(TRICKY_ARGS);
    });
  });
});

describe.skipIf(process.platform !== 'win32')('spawnArgv command lookup', () => {
  it('does not find a shim that sits only in the working folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hippo-cwd-shim-'));
    const marker = join(dir, 'ran.txt');
    writeFileSync(join(dir, 'planted.cmd'), `@echo ran> "${marker}"\r\n`);
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(dir);
    vi.stubEnv('PATH', process.env.SystemRoot ? join(process.env.SystemRoot, 'System32') : '');
    try {
      const child = spawnArgv(['planted'], { stdio: 'ignore' });
      const code = await new Promise<string>((resolve) => {
        child.on('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? 'error'));
        child.on('exit', () => resolve('exit'));
      });
      expect(code).toBe('ENOENT');
      expect(existsSync(marker)).toBe(false);
    } finally {
      cwd.mockRestore();
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
