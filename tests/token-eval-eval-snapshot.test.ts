// The eval checkout builder (prereg 51, stage 2 plan D3): rule files out, forbidden terms scrubbed, one reproducible commit.
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SCRUB_WORD, WITHHELD, buildSnapshot } from '../scripts/token-eval/eval-snapshot.mjs';
import { cleanup, tmp } from './fixtures/z0-harness.js';

const FILES = {
  'AGENTS.md': '# Rules\n- Run the linter before you commit.\n- Our memory tool is hippo.\n- Keep functions short.\n<!-- hippo:start -->\nWhen you learn something:\n```bash\nrun it\n```\n<!-- hippo:end -->\n- Name tests after behaviour.\n',
  'pkg/CLAUDE.md': 'Use tabs.\n',
  '.cursor/rules/style.mdc': 'No default exports.\n',
  '.claude/settings.local.json': '{"permissions":{"allow":["Bash(npm test)"]}}\n',
  'src/a.js': "const SLUG = /^[a-z0-9-]+$/;\r\n// tuned against the hippo store\r\n",
  '.gitignore': 'node_modules/\n.hippo/\n',
  'docs/plan.md': 'internal plan\n',
  'bin.dat': Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from('hippo')]),
} satisfies Record<string, string | Buffer>;

const OLD_AGENTS = '# Rules\n- Run the linter after you commit.\n- Our memory tool is hippo.\n';

function sourceRepo() {
  const dir = tmp('snap-src-');
  const git = (...a: string[]) => execFileSync('git', ['-c', 'core.autocrlf=false', ...a], { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  for (const [k, v] of [['user.email', 'a@example.com'], ['user.name', 'A'], ['commit.gpgsign', 'false']]) git('config', k, v);
  for (const [rel, body] of Object.entries({ ...FILES, 'AGENTS.md': OLD_AGENTS })) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  git('add', '-A');
  git('commit', '-qm', 'old rules');
  const old = git('rev-parse', 'HEAD');
  writeFileSync(join(dir, 'AGENTS.md'), FILES['AGENTS.md']);
  git('commit', '-qam', 'source');
  return { dir, commit: git('rev-parse', 'HEAD'), old };
}

describe('buildSnapshot', () => {
  afterEach(cleanup);

  it('removes rule files at any depth, withholds forbidden rule lines in place, drops and scrubs the rest', () => {
    const src = sourceRepo();
    const root = tmp('snap-out-');
    const out = join(root, 'repo');
    const rulesOut = join(root, 'rules');
    const m = buildSnapshot({ source: src.dir, commit: src.commit, out, drop: ['docs'], rulesOut });
    expect(m.ruleFiles.sort()).toEqual(['.claude/settings.local.json', '.cursor/rules/style.mdc', 'AGENTS.md', 'pkg/CLAUDE.md']);
    for (const rel of m.ruleFiles) expect(existsSync(join(out, rel))).toBe(false);
    expect(['.cursor/rules/style.mdc', 'AGENTS.md', 'pkg/CLAUDE.md'].every((rel) => existsSync(join(rulesOut, rel)))).toBe(true);
    expect(existsSync(join(rulesOut, '.claude'))).toBe(false);
    const kept = ['# Rules', '- Run the linter before you commit.', WITHHELD, '- Keep functions short.', ...Array(6).fill(WITHHELD), '- Name tests after behaviour.', ''];
    expect(readFileSync(join(rulesOut, 'AGENTS.md'), 'utf8').split('\n')).toEqual(kept);
    expect(m.withheld).toEqual({ 'AGENTS.md': [3, 5, 6, 7, 8, 9, 10] });
    // Only AGENTS.md changed, so its first version is the one earlier copy, withheld the same way.
    expect(m.history).toEqual([{ file: 'AGENTS.md', commit: src.old, date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), copy: expect.stringMatching(/^history\/AGENTS\.md\/.+\.md$/) }]);
    expect(readFileSync(join(rulesOut, m.history![0]!.copy), 'utf8').split('\n')).toEqual(['# Rules', '- Run the linter after you commit.', WITHHELD, '']);
    expect(JSON.parse(readFileSync(join(rulesOut, 'history/index.json'), 'utf8'))).toEqual(m.history);
    expect(m.dropped).toEqual(['docs/plan.md']);
    expect(m.scrubbed).toEqual({ '.gitignore': 1, 'src/a.js': 1 });
    expect(readFileSync(join(out, 'src/a.js'), 'utf8')).toBe(`const SLUG = /^[a-z0-9-]+$/;\r\n// tuned against the ${SCRUB_WORD} store\r\n`);
    expect(readFileSync(join(out, '.gitignore'), 'utf8')).toBe(`node_modules/\n.${SCRUB_WORD}/\n`);
    expect(m.binaryHits).toEqual(['bin.dat']);
    const log = execFileSync('git', ['log', '--format=%H %s'], { cwd: out, encoding: 'utf8' }).trim().split('\n');
    expect(log).toEqual([`${m.snapshotCommit} snapshot`]);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: out, encoding: 'utf8' })).toBe('');
  });

  it('keeps a tracked file that the source .gitignore matches', () => {
    const src = sourceRepo();
    const git = (...a: string[]) => execFileSync('git', ['-c', 'core.autocrlf=false', ...a], { cwd: src.dir, encoding: 'utf8' }).trim();
    mkdirSync(join(src.dir, 'node_modules'), { recursive: true });
    writeFileSync(join(src.dir, 'node_modules/vendored.js'), 'module.exports = 1;\n');
    git('add', '-f', 'node_modules/vendored.js');
    git('commit', '-qm', 'vendor');
    const out = join(tmp('snap-i-'), 'r');
    buildSnapshot({ source: src.dir, commit: git('rev-parse', 'HEAD'), out });
    expect(execFileSync('git', ['ls-files', 'node_modules'], { cwd: out, encoding: 'utf8' }).trim()).toBe('node_modules/vendored.js');
    expect(execFileSync('git', ['status', '--porcelain', '--ignored'], { cwd: out, encoding: 'utf8' })).toBe('');
  });

  it('gives the same commit for the same source, and lets the hippo-repo set keep the name', () => {
    const src = sourceRepo();
    const a = buildSnapshot({ source: src.dir, commit: src.commit, out: join(tmp('snap-a-'), 'r') });
    const b = buildSnapshot({ source: src.dir, commit: src.commit, out: join(tmp('snap-b-'), 'r') });
    expect(a.snapshotCommit).toBe(b.snapshotCommit);
    const h = buildSnapshot({ source: src.dir, commit: src.commit, out: join(tmp('snap-h-'), 'r'), forbidSet: 'hippo-repo' });
    expect(h.scrubbed).toEqual({});
    expect(() => buildSnapshot({ source: src.dir, commit: src.commit, out: join(tmp('snap-x-'), 'r'), forbidSet: 'bogus' })).toThrow(/unknown forbid set/);
  }, 120_000);
});
