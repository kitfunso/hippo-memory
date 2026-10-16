import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store/open.js';
import { runCli } from '../src/cli.js';
import { runInProcess } from './_helpers/run-in-process.js';

let home: string;

/** `hippo <args>` run in this process from `home`, the call bin/hippo.js makes; a non-zero exit fails the test. */
async function hippo(...args: string[]): Promise<string> {
  const saved = process.cwd();
  process.chdir(home);
  try {
    const r = await runInProcess(() => runCli(['node', 'hippo', ...args]));
    expect(r.status, r.stderr).toBe(0);
    return r.stdout;
  } finally {
    process.chdir(saved);
  }
}

describe('hippo recall --why exposes envelope', () => {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hippo-why-'));
    vi.stubEnv('HIPPO_HOME', home);
    // The local store `init` makes, and the global one `init --global` makes at HIPPO_HOME.
    initStore(join(home, '.hippo'));
    initStore(home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('text output includes kind, scope, owner, artifact_ref', async () => {
    await hippo('remember', 'envelope-canary-marker uniq42 distinguishing token', '--kind', 'distilled', '--scope', 'team:eng', '--owner', 'user:42', '--artifact-ref', 'gh://owner/repo/pr/123', '--global');
    const out = await hippo('recall', 'envelope-canary-marker uniq42', '--why');
    expect(out).toContain('kind: distilled');
    expect(out).toContain('scope: team:eng');
    expect(out).toContain('owner: user:42');
    expect(out).toContain('artifact_ref: gh://owner/repo/pr/123');
    expect(out).toMatch(/confidence: \w+/);
  });

  it('CLI rejects --kind raw (reserved for ingestion connectors, not user-facing)', async () => {
    const saved = process.cwd();
    process.chdir(home);
    try {
      const r = await runInProcess(() => runCli(['node', 'hippo', 'remember', 'should fail', '--kind', 'raw', '--global']));
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('Invalid --kind: "raw"');
      expect(r.stderr).toContain('reserved for ingestion connectors');
    } finally {
      process.chdir(saved);
    }
  });

  it('JSON output includes envelope object when --why is set', async () => {
    await hippo('remember', 'envelope-json-marker rollback-uniq43 token', '--kind', 'distilled', '--owner', 'agent:claude', '--artifact-ref', 'slack://team/channel/1700.123', '--global');
    const parsed = JSON.parse(await hippo('recall', 'envelope-json-marker rollback-uniq43', '--why', '--json'));
    expect(parsed.results.length).toBeGreaterThan(0);
    const first = parsed.results[0];
    expect(first.envelope).toBeDefined();
    expect(first.envelope.kind).toBe('distilled');
    expect(first.envelope.owner).toBe('agent:claude');
    expect(first.envelope.artifact_ref).toBe('slack://team/channel/1700.123');
  });
});
