import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { findCliRecallWrites, namedOnLines, RECALL_ONLY } from '../scripts/check-cli-recall-writes.mjs';

describe('check-cli-recall-writes', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cli-recall-writes-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function file(name: string, body: string): void {
    const p = join(dir, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body, 'utf8');
  }

  it('the real src/cli tree neither ranks nor records a recall itself', () => {
    expect(findCliRecallWrites('src')).toEqual([]);
  });

  it('the ranking core has one caller in src/, the shared entry', () => {
    const callers = readdirSync('src', { recursive: true, encoding: 'utf8' })
      .map((rel) => rel.split(sep).join('/'))
      .filter((rel) => rel.endsWith('.ts') && rel !== 'recall-pipeline.ts')
      .filter((rel) => namedOnLines(readFileSync(join('src', rel), 'utf8'), ['rankRecall']).length > 0);
    expect(callers).toEqual(['api/recall-core.ts']);
  });

  it('flags a call, a member call and an import, and skips comments and longer names', () => {
    const text = [
      "import { saveIndex } from '../store/index-and-stats.js';",
      'await store.finishRecall(writes);',
      '// rankRecall in a comment',
      'const saveIndexLater = 1; /* strengthenRetrieved in a block */',
      'strengthenRetrieved(root, ids, gate); rankRecall(ctx, opts);',
    ].join('\n');
    expect(namedOnLines(text, RECALL_ONLY)).toEqual([
      { line: 1, name: 'saveIndex' },
      { line: 2, name: 'finishRecall' },
      { line: 5, name: 'strengthenRetrieved' },
      { line: 5, name: 'rankRecall' },
    ]);
  });

  it('bans the recall-only names in every CLI file and the shared writers in the recall verbs alone', () => {
    file('cli/recall.ts', 'withLedgerDb(root, fn);\nupdateStats(root, { recalled: 1 });\n');
    file('cli/explain.ts', 'const db = openHippoDb(root);\n');
    file('cli/context.ts', 'withLedgerDb(root, fn);\nwriteRecallTraceAtRoot(root, input);\n');
    file('cli.ts', 'bumpRecallStats(3);\n');
    file('api/recall-core.ts', 'rankRecall(ctx, opts);\nsaveIndex(root, markers);\n');
    expect(findCliRecallWrites(dir)).toEqual([
      { file: 'cli.ts', line: 1, name: 'bumpRecallStats' },
      { file: 'cli/context.ts', line: 2, name: 'writeRecallTraceAtRoot' },
      { file: 'cli/explain.ts', line: 1, name: 'openHippoDb' },
      { file: 'cli/recall.ts', line: 1, name: 'withLedgerDb' },
      { file: 'cli/recall.ts', line: 2, name: 'updateStats' },
    ]);
  });
});
