import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';

const repoRoot = resolve(__dirname, '..');
const cli = resolve(repoRoot, 'dist', 'cli.js');

describe('hippo recall --why exposes envelope', () => {
  it('text output includes kind, scope, owner, artifact_ref', () => {
    if (!existsSync(cli)) {
      throw new Error(`dist/cli.js not found at ${cli} — run \`npm run build\` first`);
    }
    const home = mkdtempSync(join(tmpdir(), 'hippo-why-'));
    const env = { ...process.env, HIPPO_HOME: home };
    try {
      execSync(`node "${cli}" init`, { env, cwd: home });
      execSync(`node "${cli}" init --global`, { env, cwd: home });
      execSync(
        `node "${cli}" remember "envelope-canary-marker uniq42 distinguishing token" --kind distilled --scope team:eng --owner user:42 --artifact-ref gh://owner/repo/pr/123 --global`,
        { env, cwd: home },
      );
      const out = execSync(`node "${cli}" recall "envelope-canary-marker uniq42" --why --global`, { env, cwd: home }).toString();
      expect(out).toContain('kind: distilled');
      expect(out).toContain('scope: team:eng');
      expect(out).toContain('owner: user:42');
      expect(out).toContain('artifact_ref: gh://owner/repo/pr/123');
      expect(out).toMatch(/confidence: \w+/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('JSON output includes envelope object when --why is set', () => {
    if (!existsSync(cli)) {
      throw new Error(`dist/cli.js not found at ${cli} — run \`npm run build\` first`);
    }
    const home = mkdtempSync(join(tmpdir(), 'hippo-why-json-'));
    const env = { ...process.env, HIPPO_HOME: home };
    try {
      execSync(`node "${cli}" init`, { env, cwd: home });
      execSync(`node "${cli}" init --global`, { env, cwd: home });
      execSync(
        `node "${cli}" remember "envelope-json-marker rollback-uniq43 token" --kind raw --owner agent:claude --artifact-ref slack://team/channel/1700.123 --global`,
        { env, cwd: home },
      );
      const out = execSync(`node "${cli}" recall "envelope-json-marker rollback-uniq43" --why --json --global`, { env, cwd: home }).toString();
      const parsed = JSON.parse(out);
      expect(parsed.results.length).toBeGreaterThan(0);
      const first = parsed.results[0];
      expect(first.envelope).toBeDefined();
      expect(first.envelope.kind).toBe('raw');
      expect(first.envelope.owner).toBe('agent:claude');
      expect(first.envelope.artifact_ref).toBe('slack://team/channel/1700.123');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
