import { describe, it, expect } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = join(import.meta.dirname, '..', '..');
const SCRIPT = join(REPO, 'scripts', 'checks', 'check-hook-block-hashes.mjs');
const DIST_FILES = ['dist/surface/hooks-install/rules/hook-blocks.js', 'dist/base/util/escape.js'];
const DIST_BLOCKS = DIST_FILES[0];
const SRC_BLOCKS = 'src/surface/hooks-install/rules/hook-blocks.ts';
// The Pi footer is the one sentence only the pi block carries, so a change to it moves one agent's hash.
const PI_SENTENCE = 'copy the hippo-memory Pi extension';

function withScratchRoot(body: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'hippo-hook-hashes-'));
  try {
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    for (const rel of [...DIST_FILES, SRC_BLOCKS]) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      cpSync(join(REPO, rel), join(root, rel));
    }
    body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runCheck(root: string) {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', root], { cwd: root, encoding: 'utf-8' });
  return { status: r.status, output: r.stdout + r.stderr };
}

function editFile(root: string, rel: string, change: (text: string) => string): void {
  const file = join(root, rel);
  const before = readFileSync(file, 'utf-8');
  const after = change(before);
  expect(after).not.toBe(before);
  writeFileSync(file, after);
}

const withoutPiHashes = (text: string): string => text.replace(/^.*'[0-9a-f]{64}', 'pi'\],\r?\n/gm, '');

describe('check-hook-block-hashes.mjs', () => {
  it('passes when every current block text has its hash listed', () => {
    withScratchRoot((root) => {
      const { status, output } = runCheck(root);
      expect(output).toContain('OK');
      expect(status).toBe(0);
    });
  });

  it('fails and names the agent whose block text changed', () => {
    withScratchRoot((root) => {
      editFile(root, DIST_BLOCKS, (text) => text.replace(PI_SENTENCE, 'copy the hippo-memory Pi plugin'));
      const { status, output } = runCheck(root);
      expect(status).toBe(1);
      expect(output).toMatch(/\['[0-9a-f]{64}', 'pi'\],/);
      expect(output).not.toMatch(/'(?:claude-code|codex|cursor|openclaw|opencode)'\],/);
    });
  });

  it('fails when the hashes of an agent are gone from the source list', () => {
    withScratchRoot((root) => {
      editFile(root, SRC_BLOCKS, withoutPiHashes);
      const { status, output } = runCheck(root);
      expect(status).toBe(1);
      expect(output).toMatch(/\['[0-9a-f]{64}', 'pi'\],/);
    });
  });

  it('counts only the list, so the same hash written elsewhere in the file does not hide a miss', () => {
    withScratchRoot((root) => {
      editFile(root, SRC_BLOCKS, withoutPiHashes);
      const hash = /\['([0-9a-f]{64})', 'pi'\],/.exec(runCheck(root).output)?.[1];
      expect(hash).toBeDefined();
      editFile(root, SRC_BLOCKS, (text) => `// '${hash}'\n${text}`);
      expect(runCheck(root).status).toBe(1);
    });
  });

  it('exits 2 and says to build when the built block file is missing', () => {
    withScratchRoot((root) => {
      rmSync(join(root, DIST_BLOCKS));
      const { status, output } = runCheck(root);
      expect(status).toBe(2);
      expect(output).toContain('npm run build');
    });
  });

  it('exits 2 when the source file is missing', () => {
    withScratchRoot((root) => {
      rmSync(join(root, SRC_BLOCKS));
      const { status, output } = runCheck(root);
      expect(status).toBe(2);
      expect(output).toContain('hook-blocks.ts');
    });
  });
});
