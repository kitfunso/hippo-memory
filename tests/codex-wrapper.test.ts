import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// withFakeHome empties PATH; a child process still needs node and cmd.exe.
const prevPathForChild = process.env.PATH ?? '';

import {
  ensureCodexWrapperInstalled,
  installCodexWrapper,
  isCodexWrapperInstalled,
  repairCodexWrapperIfInstalled,
  uninstallCodexWrapper,
  resolveCodexSessionTranscript,
  resolveCodexWrapperPaths,
} from '../src/hooks.js';
import { initStore, loadAllEntries } from '../src/store.js';

const HIPPO_JS = path.resolve(__dirname, '..', 'bin', 'hippo.js');

function setCodexHome(value: string | undefined): void {
  if (value === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = value;
}

function withFakeHome() {
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevPath = process.env.PATH;
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-codex-wrapper-test-'));
  process.env.HOME = fake;
  process.env.USERPROFILE = fake;
  process.env.PATH = '';
  return {
    home: fake,
    cleanup: () => {
      process.env.HOME = prevHome;
      process.env.USERPROFILE = prevUserProfile;
      process.env.PATH = prevPath;
      // The detached capture worker can still hold the temp dir for a moment after a test.
      fs.rmSync(fake, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}

// The wrapper installer's behaviour is Windows-specific (it produces a
// `codex.cmd` shim that re-launches `codex.exe` so hippo can intercept the
// session transcript). Linux/macOS do not need a shim for the same flow,
// so the assertions diverge by platform. Skip on non-Windows in CI.
describe.skipIf(process.platform !== 'win32')('Codex wrapper install', () => {
  let env: { cleanup: () => void; home: string };

  beforeEach(() => {
    env = withFakeHome();
  });

  afterEach(() => {
    env.cleanup();
  });

  it('wraps a cmd launcher in place and records backup metadata', () => {
    const realCodex = path.join(env.home, 'real-bin', 'codex.cmd');
    fs.mkdirSync(path.dirname(realCodex), { recursive: true });
    fs.writeFileSync(realCodex, '@echo off\r\necho real codex\r\n', 'utf8');

    const result = installCodexWrapper(realCodex);
    const paths = resolveCodexWrapperPaths();

    expect(result.installed).toBe(true);
    expect(result.metadataPath).toBe(paths.metadataPath);
    expect(result.commandPath).toBe(realCodex);
    expect(result.backupPath).toBe(path.join(env.home, 'real-bin', 'codex.hippo-real.cmd'));
    expect(fs.existsSync(result.backupPath)).toBe(true);
    expect(fs.readFileSync(result.backupPath, 'utf8')).toContain('real codex');
    expect(fs.readFileSync(realCodex, 'utf8')).toContain('codex-run');

    const metadata = JSON.parse(fs.readFileSync(paths.metadataPath, 'utf8'));
    expect(metadata.originalCodexPath).toBe(realCodex);
    expect(metadata.realCodexPath).toBe(result.backupPath);
    expect(metadata.commandPath).toBe(realCodex);
    expect(metadata.installMode).toBe('same-path');
  });

  it('uses a codex.cmd shim when the detected launcher is an exe', () => {
    const realCodex = path.join(env.home, 'real-bin', 'codex.exe');
    fs.mkdirSync(path.dirname(realCodex), { recursive: true });
    fs.writeFileSync(realCodex, 'binary', 'utf8');

    const result = installCodexWrapper(realCodex);

    expect(result.commandPath).toBe(path.join(env.home, 'real-bin', 'codex.cmd'));
    expect(result.backupPath).toBe(path.join(env.home, 'real-bin', 'codex.hippo-real.exe'));
    expect(fs.existsSync(result.backupPath)).toBe(true);
    expect(fs.existsSync(result.commandPath)).toBe(true);
    expect(fs.existsSync(realCodex)).toBe(false);
    expect(fs.readFileSync(result.commandPath, 'utf8')).toContain('codex-run');
  });

  it('restores the original launcher on uninstall', () => {
    const realCodex = path.join(env.home, 'real-bin', 'codex.cmd');
    fs.mkdirSync(path.dirname(realCodex), { recursive: true });
    fs.writeFileSync(realCodex, '@echo off\r\necho real codex\r\n', 'utf8');

    installCodexWrapper(realCodex);
    const backupPath = path.join(env.home, 'real-bin', 'codex.hippo-real.cmd');
    const paths = resolveCodexWrapperPaths();

    expect(uninstallCodexWrapper()).toBe(true);
    expect(fs.existsSync(paths.metadataPath)).toBe(false);
    expect(fs.existsSync(backupPath)).toBe(false);
    expect(fs.existsSync(realCodex)).toBe(true);
    expect(fs.readFileSync(realCodex, 'utf8')).toContain('real codex');
  });

  it('auto-installs the Codex wrapper from PATH discovery', () => {
    const realBin = path.join(env.home, 'real-bin');
    const realCodex = path.join(realBin, 'codex.cmd');
    fs.mkdirSync(realBin, { recursive: true });
    fs.writeFileSync(realCodex, '@echo off\r\necho real codex\r\n', 'utf8');
    process.env.PATH = realBin;

    const result = ensureCodexWrapperInstalled();
    const metadata = JSON.parse(fs.readFileSync(resolveCodexWrapperPaths().metadataPath, 'utf8'));

    expect(result.status).toBe('installed');
    expect(metadata.commandPath).toBe(realCodex);
    expect(fs.readFileSync(realCodex, 'utf8')).toContain('codex-run');
  });

  it('repair-only ensure never first-installs, even with codex on PATH', () => {
    const realBin = path.join(env.home, 'real-bin');
    const realCodex = path.join(realBin, 'codex.cmd');
    fs.mkdirSync(realBin, { recursive: true });
    fs.writeFileSync(realCodex, '@echo off\r\necho real codex\r\n', 'utf8');
    process.env.PATH = realBin;

    const result = repairCodexWrapperIfInstalled();

    expect(result.status).toBe('not-found');
    expect(isCodexWrapperInstalled()).toBe(false);
    // The user's real launcher is untouched: no wrapper content, no backup.
    expect(fs.readFileSync(realCodex, 'utf8')).toContain('real codex');
    expect(fs.existsSync(path.join(realBin, 'codex.hippo-real.cmd'))).toBe(false);
  });

  it('repair-only ensure restores a clobbered wrapper for an opted-in user', () => {
    const realBin = path.join(env.home, 'real-bin');
    const realCodex = path.join(realBin, 'codex.cmd');
    fs.mkdirSync(realBin, { recursive: true });
    fs.writeFileSync(realCodex, '@echo off\r\necho real codex\r\n', 'utf8');
    process.env.PATH = realBin;

    // Explicit opt-in first (what `hippo hook install codex` runs).
    expect(ensureCodexWrapperInstalled().status).toBe('installed');
    // Simulate a Codex update clobbering the shim with a fresh real launcher.
    fs.writeFileSync(realCodex, '@echo off\r\necho updated real codex\r\n', 'utf8');

    const installedCli = path.join(env.home, 'npm', 'node_modules', 'hippo-memory', 'bin', 'hippo.js');
    const result = repairCodexWrapperIfInstalled(installedCli);

    expect(result.status).toBe('installed');
    expect(fs.readFileSync(realCodex, 'utf8')).toContain('codex-run');
  });

  it('repair-only ensure never points the launcher at a source checkout', () => {
    const realBin = path.join(env.home, 'real-bin');
    const realCodex = path.join(realBin, 'codex.cmd');
    fs.mkdirSync(realBin, { recursive: true });
    fs.writeFileSync(realCodex, '@echo off\r\necho real codex\r\n', 'utf8');
    process.env.PATH = realBin;

    expect(ensureCodexWrapperInstalled().status).toBe('installed');
    fs.writeFileSync(realCodex, '@echo off\r\necho updated real codex\r\n', 'utf8');

    // No argument: the running copy is this checkout, as in a checkout's own npm install.
    const result = repairCodexWrapperIfInstalled();

    expect(result.status).toBe('source-checkout');
    expect(fs.readFileSync(realCodex, 'utf8')).toContain('updated real codex');
    expect(isCodexWrapperInstalled()).toBe(true);
  });

  it('codex-run launches a cmd launcher and passes every argument through intact', () => {
    const realBin = path.join(env.home, 'real bin');
    const realCodex = path.join(realBin, 'codex.cmd');
    const argvOut = path.join(env.home, 'argv.json');
    fs.mkdirSync(realBin, { recursive: true });
    fs.writeFileSync(
      realCodex,
      '@echo off\r\nnode -e "require(\'fs\').writeFileSync(process.env.ARGV_OUT, JSON.stringify(process.argv.slice(1)))" -- %*\r\n',
      'utf8',
    );
    installCodexWrapper(realCodex);

    const forwarded = ['exec', 'fix the bug & ship', 'a "quoted" word', ''];
    execFileSync('node', [path.join(process.cwd(), 'bin', 'hippo.js'), 'codex-run', '--', ...forwarded], {
      cwd: env.home,
      env: { ...process.env, PATH: prevPathForChild, HOME: env.home, USERPROFILE: env.home, HIPPO_HOME: path.join(env.home, '.hippo-global'), HIPPO_SKIP_AUTO_INTEGRATIONS: '1', ARGV_OUT: argvOut },
      stdio: 'pipe',
    });

    expect(JSON.parse(fs.readFileSync(argvOut, 'utf8'))).toEqual(forwarded);

    // codex-run leaves a detached session-end worker; let it finish before cleanup removes its folder.
    const workerLog = resolveCodexWrapperPaths().logFile;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !(fs.existsSync(workerLog) && fs.readFileSync(workerLog, 'utf8').includes('skip:'))) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
    expect(fs.readFileSync(workerLog, 'utf8')).toContain('skip: no hippo store');
  });
});

describe('resolveCodexSessionTranscript', () => {
  let env: { cleanup: () => void; home: string };

  beforeEach(() => {
    env = withFakeHome();
  });

  afterEach(() => {
    env.cleanup();
  });

  it('prefers the transcript whose filename matches the new Codex session id in history.jsonl', () => {
    const codexHome = path.join(env.home, '.codex');
    const sessionsDir = path.join(codexHome, 'sessions', '2026', '04', '15');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const historyPath = path.join(codexHome, 'history.jsonl');
    fs.mkdirSync(path.dirname(historyPath), { recursive: true });
    const before = JSON.stringify({ session_id: 'old-session', ts: 1, text: 'before' }) + '\n';
    fs.writeFileSync(historyPath, before, 'utf8');
    const startOffset = Buffer.byteLength(before);
    fs.appendFileSync(
      historyPath,
      JSON.stringify({ session_id: 'new-session', ts: 2, text: 'after' }) + '\n',
      'utf8',
    );

    const wanted = path.join(sessionsDir, 'rollout-2026-04-15T21-18-20-new-session.jsonl');
    const other = path.join(sessionsDir, 'rollout-2026-04-15T20-00-00-old-session.jsonl');
    fs.writeFileSync(wanted, '{}\n', 'utf8');
    fs.writeFileSync(other, '{}\n', 'utf8');

    expect(
      resolveCodexSessionTranscript({
        codexHome,
        historyPath,
        startOffsetBytes: startOffset,
        startedAtMs: Date.now() - 1_000,
      }),
    ).toBe(wanted);
  });
});

describe('resolveCodexWrapperPaths and CODEX_HOME', () => {
  let env: { cleanup: () => void; home: string };
  const prevCodexHome = process.env.CODEX_HOME;

  beforeEach(() => {
    env = withFakeHome();
  });

  afterEach(() => {
    setCodexHome(prevCodexHome);
    env.cleanup();
  });

  it('puts the history and sessions paths under $CODEX_HOME and keeps hippo-owned paths under HOME', () => {
    const codexHome = path.join(env.home, 'elsewhere', 'codex-home');
    setCodexHome(codexHome);

    const paths = resolveCodexWrapperPaths();

    expect(paths.codexHome).toBe(codexHome);
    expect(paths.historyPath).toBe(path.join(codexHome, 'history.jsonl'));
    expect(paths.metadataPath).toBe(path.join(env.home, '.hippo', 'integrations', 'codex.json'));
    expect(paths.logFile).toBe(path.join(env.home, '.hippo', 'logs', 'codex-sleep.log'));
    expect(paths.runsDir).toBe(path.join(env.home, '.hippo', 'runs', 'codex'));
  });

  it('falls back to ~/.codex when CODEX_HOME is unset or empty', () => {
    for (const value of [undefined, '']) {
      setCodexHome(value);
      const paths = resolveCodexWrapperPaths();
      expect(paths.codexHome).toBe(path.join(env.home, '.codex'));
      expect(paths.historyPath).toBe(path.join(env.home, '.codex', 'history.jsonl'));
    }
  });
});

describe('codex-run captures from the CODEX_HOME it launches under', () => {
  const SENTINEL = 'zeta-7731';
  const DECOY = 'decoy-4410';
  let root: string;
  let env: { cleanup: () => void; home: string };
  const prevCodexHome = process.env.CODEX_HOME;

  beforeEach(() => {
    env = withFakeHome();
    root = env.home;
  });

  afterEach(() => {
    setCodexHome(prevCodexHome);
    env.cleanup();
  });

  const rollout = (text: string): string =>
    [
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Noted.' }] } },
    ].map((line) => JSON.stringify(line)).join('\n') + '\n';

  const ruleText = (name: string): string =>
    `We decided how to ship the ${name} service. Never deploy the ${name} service on Fridays; the runbook is runbook-${name}.md.`;

  // Writes only under the CODEX_HOME it launches with, so a captured sentinel proves the launch-time home won.
  function writeStandInCodex(dir: string): string {
    fs.mkdirSync(dir, { recursive: true });
    const script = path.join(dir, 'fake-codex.js');
    fs.writeFileSync(script, [
      "const fs = require('fs');",
      "const path = require('path');",
      'const home = process.env.CODEX_HOME;',
      "const sessions = path.join(home, 'sessions', '2026', '10', '03');",
      'fs.mkdirSync(sessions, { recursive: true });',
      `fs.appendFileSync(path.join(home, 'history.jsonl'), JSON.stringify({ session_id: 'sess-b', ts: 2, text: 'hi' }) + '\\n');`,
      `fs.writeFileSync(path.join(sessions, 'rollout-2026-10-03T10-00-00-sess-b.jsonl'), ${JSON.stringify(rollout(ruleText(SENTINEL)))});`,
      '',
    ].join('\n'), 'utf8');

    if (process.platform === 'win32') {
      // Not codex.cmd: spawnRealCodex's cmd.exe quoting cannot launch a .cmd backup (the run reports it as not recognized).
      const launcher = path.join(dir, 'codex.ps1');
      const ps = (s: string): string => `'${s.replace(/'/g, "''")}'`;
      fs.writeFileSync(launcher, `& ${ps(process.execPath)} ${ps(script)} @args\r\n`, 'utf8');
      return launcher;
    }
    const launcher = path.join(dir, 'codex');
    fs.writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, 'utf8');
    fs.chmodSync(launcher, 0o755);
    return launcher;
  }

  it('reads history and transcripts from the launch-time CODEX_HOME, not the install-time one', async () => {
    const homeA = path.join(root, 'codex-a');
    const homeB = path.join(root, 'codex-b');
    const sessionsA = path.join(homeA, 'sessions', '2026', '10', '03');
    fs.mkdirSync(sessionsA, { recursive: true });
    fs.mkdirSync(homeB, { recursive: true });
    fs.writeFileSync(path.join(homeA, 'history.jsonl'), JSON.stringify({ session_id: 'sess-a', ts: 1, text: 'old' }) + '\n', 'utf8');
    const decoy = path.join(sessionsA, 'rollout-2026-10-03T09-00-00-sess-a.jsonl');
    fs.writeFileSync(decoy, rollout(ruleText(DECOY)), 'utf8');
    // A newer mtime lets a wrapper that still looks in A pick the decoy by recency.
    const future = new Date(Date.now() + 120_000);
    fs.utimesSync(decoy, future, future);

    const globalRoot = path.join(root, 'global');
    initStore(globalRoot);
    const work = path.join(root, 'work');
    fs.mkdirSync(work, { recursive: true });
    const standIn = writeStandInCodex(path.join(root, 'real-bin'));

    setCodexHome(homeA);
    installCodexWrapper(standIn);
    const { logFile } = resolveCodexWrapperPaths();

    // The wrapper spawns powershell.exe or cmd.exe by bare name on Windows, so those folders must stay on PATH.
    const system32 = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32');
    const systemDirs = process.platform === 'win32' ? [system32, path.join(system32, 'WindowsPowerShell', 'v1.0')] : ['/usr/bin', '/bin'];
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HIPPO_HOME: globalRoot,
      HOME: root,
      USERPROFILE: root,
      APPDATA: path.join(root, 'appdata'),
      CODEX_HOME: homeB,
      PATH: [path.join(root, 'real-bin'), path.dirname(process.execPath), ...systemDirs].join(path.delimiter),
    };
    delete childEnv.CLAUDE_CODE_SESSION_ID;
    delete childEnv.HIPPO_SESSION_ID;

    const run = spawnSync(process.execPath, [HIPPO_JS, 'codex-run', '--'], { cwd: work, env: childEnv, encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);

    const saved = (): string[] => loadAllEntries(globalRoot, 'default').map((e) => e.content);
    const readLog = (): string => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '');
    // The worker is detached, so wait for either its capture or its skip line.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !saved().some((c) => c.includes(SENTINEL)) && !readLog().includes('skip capture')) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    expect(readLog()).not.toContain('skip capture');
    expect(saved().some((c) => c.includes(SENTINEL))).toBe(true);
    expect(saved().some((c) => c.includes(DECOY))).toBe(false);
  }, 60_000);
});
