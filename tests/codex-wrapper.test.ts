import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ensureCodexWrapperInstalled,
  installCodexWrapper,
  uninstallCodexWrapper,
  resolveCodexSessionTranscript,
  resolveCodexWrapperPaths,
} from '../src/hooks.js';

function withFakeHome(): { cleanup: () => void; home: string } {
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
      fs.rmSync(fake, { recursive: true, force: true });
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
