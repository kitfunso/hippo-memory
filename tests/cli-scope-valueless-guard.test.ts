/**
 * v1.26.2 (hardening pass) — global `--scope` well-formedness guard (T1).
 *
 * Before this release a value-less `--scope` (parseArgs stores it as boolean
 * `true`) misbehaved differently at each of 14 consumer sites across 7
 * commands: some coerced it to the literal scope string `'true'` (recall
 * filter/unlock input, wm session scope, the remember scope-tag dual-write),
 * others silently dropped the user's scoping intent (the remember envelope
 * WRITE — the worst variant, since the tag half still wrote `scope:true` in
 * the same command). T1 replaces all of that with ONE global guard in the
 * CLI dispatch function, before the top-level command switch: any `--scope`
 * present but not a non-empty string exits 1 with a single usage message,
 * on every command — including ones that ignore `--scope` today.
 *
 * This file covers acceptance criteria 1 (exit-1 on all 7 owning commands +
 * the empty/whitespace variants + the ignores-scope pin) and criterion 2
 * (valued-scope regression coverage for the three surfaces that had none:
 * wm push/read roundtrip, assemble passthrough, thin-client remember).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeEntry } from '../src/store.js';
import { createMemory, type MemoryKind } from '../src/memory.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { serve, type ServerHandle } from '../src/server.js';

const HIPPO_BIN = join(process.cwd(), 'bin', 'hippo.js');
const USAGE_MSG = '--scope requires a non-empty value (e.g. --scope slack:private:C1).';

function hippo(cwd: string, env: Record<string, string>, ...args: string[]): string {
  return execFileSync('node', [HIPPO_BIN, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf-8',
  });
}

function hippoRun(
  cwd: string,
  env: Record<string, string>,
  ...args: string[]
): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync('node', [HIPPO_BIN, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf-8',
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

// Non-blocking variant (mirrors tests/cli-thin-client.test.ts's runCliAsync):
// execFileSync/spawnSync freeze this process's event loop for the whole
// child run, which would starve the in-test serve() HTTP server this file
// spins up for the thin-client remember case below — its /health probe and
// the actual POST /v1/memories would never get a turn to run. spawn() keeps
// the parent event loop free while the child does its HTTP round trip.
function hippoAsync(
  cwd: string,
  env: Record<string, string>,
  ...args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', [HIPPO_BIN, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
    child.on('close', () => resolve({ stdout, stderr }));
  });
}

describe('global --scope value-less guard (v1.26.2 T1) — exit-1 cases', () => {
  let home: string;
  let env: Record<string, string>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hippo-scope-guard-'));
    env = { HIPPO_HOME: join(home, 'global-hippo'), HIPPO_SKIP_AUTO_INTEGRATIONS: '1' };
    hippo(home, env, 'init', '--no-hooks', '--no-schedule', '--no-learn');
  });

  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  // Acceptance criterion 1: value-less --scope on all 7 owning commands
  // (10 cases — wm has 4 subcommands). The guard fires pre-dispatch, so no
  // live server is needed and command-specific argument validity does not
  // matter — a value-less --scope always exits 1 before any command logic
  // runs.
  const valuelessCases: Array<{ label: string; args: string[] }> = [
    { label: 'remember', args: ['remember', 'some memory content', '--scope'] },
    { label: 'recall', args: ['recall', 'some query', '--scope'] },
    { label: 'explain', args: ['explain', 'some query', '--scope'] },
    { label: 'context', args: ['context', 'some query', '--scope'] },
    { label: 'import', args: ['import', 'nonexistent-file.json', '--scope'] },
    { label: 'wm push', args: ['wm', 'push', '--content', 'wm item', '--scope'] },
    { label: 'wm read', args: ['wm', 'read', '--scope'] },
    { label: 'wm clear', args: ['wm', 'clear', '--scope'] },
    { label: 'wm flush', args: ['wm', 'flush', '--scope'] },
    { label: 'assemble', args: ['assemble', '--session', 's1', '--scope'] },
  ];

  for (const c of valuelessCases) {
    it(`${c.label}: value-less --scope exits 1 with the usage message`, () => {
      const res = hippoRun(home, env, ...c.args);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain(USAGE_MSG);
    });
  }

  // parseArgs stores `--scope ''` the same as value-less (empty string is
  // falsy, so the "no next token" boolean-flag branch fires) — representative
  // case on recall.
  it('recall: --scope "" (empty string) exits 1', () => {
    const res = hippoRun(home, env, 'recall', 'some query', '--scope', '');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(USAGE_MSG);
  });

  // `--scope "   "` parses as a real (non-boolean) string, so this exercises
  // the guard's second branch (typeof is 'string' but .trim() is empty) —
  // representative case on recall.
  it('recall: --scope "   " (whitespace-only) exits 1', () => {
    const res = hippoRun(home, env, 'recall', 'some query', '--scope', '   ');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(USAGE_MSG);
  });

  // Pins the GLOBAL semantics: `status` never reads flags['scope'] (cmdStatus
  // takes only hippoRoot), yet a value-less --scope still exits 1 because the
  // guard runs before dispatch, uniformly, regardless of whether the target
  // command would have consumed the flag.
  it('status (a command that ignores --scope today): value-less --scope still exits 1 (pins global-guard semantics)', () => {
    const res = hippoRun(home, env, 'status', '--scope');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(USAGE_MSG);
  });
});

describe('valued --scope regression coverage (v1.26.2 acceptance criterion 2)', () => {
  let home: string;
  let env: Record<string, string>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hippo-scope-valued-'));
    env = { HIPPO_HOME: join(home, 'global-hippo'), HIPPO_SKIP_AUTO_INTEGRATIONS: '1' };
    hippo(home, env, 'init', '--no-hooks', '--no-schedule', '--no-learn');
  });

  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  // (a) wm push --scope X / wm read --scope X roundtrip.
  it('wm push --scope X then wm read --scope X roundtrip surfaces the item', () => {
    hippo(home, env, 'wm', 'push', '--scope', 'projX', '--content', 'wm item one');
    const scoped = hippo(home, env, 'wm', 'read', '--scope', 'projX');
    expect(scoped).toContain('wm item one');

    // Current contract (pinned, not asserted-as-desired): wmRead only adds a
    // `WHERE scope = ?` clause when a scope is explicitly passed; a bare
    // `wm read` applies no scope filter at all (src/working-memory.ts
    // wmRead), so it is NOT isolated from scope-X items — they show up here
    // too. If wm read's default-scope behavior changes, update this pin.
    const unscoped = hippo(home, env, 'wm', 'read');
    expect(unscoped).toContain('wm item one');
  });

  // (b) assemble --scope X passthrough — pin CURRENT behavior. cmdAssemble
  // forwards --scope straight to api.assemble's opts.scope, which resolves
  // through passesScopeFilterForRecall (the API 'exact' mode, NOT the CLI
  // recall's additive-unlock mode): when a scope is requested, ONLY rows
  // whose envelope scope equals it exactly pass — NULL-scope rows and other
  // non-matching scopes are excluded, unlike `hippo recall --scope`.
  it('assemble --scope X pins CURRENT exact-narrowing behavior (api.assemble -> passesScopeFilterForRecall)', () => {
    const hippoDir = join(home, '.hippo');
    const sessionId = 'sess-scope-pin';
    const mkRaw = (text: string, scope: string | null) => createMemory(text, {
      kind: 'raw' as MemoryKind,
      tenantId: 'default',
      source_session_id: sessionId,
      scope,
    });
    writeEntry(hippoDir, mkRaw('null scope row content here', null));
    writeEntry(hippoDir, mkRaw('projx scope row content here', 'projX'));
    writeEntry(hippoDir, mkRaw('projy scope row content here', 'projY'));

    const raw = hippo(home, env, 'assemble', '--session', sessionId, '--scope', 'projX', '--json');
    const parsed = JSON.parse(raw) as { items: Array<{ content: string }> };
    const contents = parsed.items.map((it) => it.content);
    expect(contents.some((c) => c.includes('projx scope row'))).toBe(true);
    expect(contents.some((c) => c.includes('null scope row'))).toBe(false);
    expect(contents.some((c) => c.includes('projy scope row'))).toBe(false);
  });

  // (c) thin-client remember: with a live in-test serve(), `hippo remember
  // <text> --scope X` relays via HTTP (case 'remember' in cli.ts) and the
  // stored row's envelope scope is X.
  it('thin-client remember: hippo remember --scope X relays via a live server and the stored row envelope scope is X', async () => {
    const hippoDir = join(home, '.hippo');
    const handle: ServerHandle = await serve({ hippoRoot: hippoDir, port: 0 });
    try {
      const { stdout: out, stderr: err } = await hippoAsync(
        home, env, 'remember', 'thin client scope canary content', '--scope', 'slack:private:CX',
      );
      expect(out, `stderr: ${err}`).toMatch(/Remembered/);
      expect(out).toContain(handle.url);

      const db = openHippoDb(hippoDir);
      try {
        const row = db
          .prepare(`SELECT scope FROM memories WHERE content = ?`)
          .get('thin client scope canary content') as { scope: string | null } | undefined;
        expect(row?.scope).toBe('slack:private:CX');
      } finally {
        closeHippoDb(db);
      }
    } finally {
      await handle.stop();
    }
  });
});
