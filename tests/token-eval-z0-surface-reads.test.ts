// Z0 readers of what the runner recorded: screen verdicts over void sessions, leak scans through directory links, injected bullets with blank lines.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/memory.js';
import { contextLine } from '../src/context-render.js';
import { injectedRows } from '../scripts/token-eval/surfaces.mjs';
import { storedAt } from '../scripts/token-eval/leaks.mjs';
import { screenVerdicts } from '../scripts/token-eval/screen.mjs';

const dirs: string[] = [];
const tmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 5 });
});

describe('screen verdicts', () => {
  const spec = {
    families: [{ id: 'f1', sequence: 's1', screen: { id: 'scr' }, lessons: [{ id: 'f1-l1' }] }],
    sequences: [{ id: 's1', tasks: [{ id: 't1', kind: 'teach', lessonId: 'f1-l1' }] }],
  };
  interface Marks { void?: string }
  const rec = (arm: string, seed: number, taskId: string, first: string, extra: Marks = {}) => ({ familyId: 'f1', arm, seed, taskId, invalid: null, void: null, lessons: [{ first }], ...extra });
  const records = (a0Extra: Marks) => [
    rec('A0', 1, 't1', 'fail', a0Extra), rec('A0', 1, 'scr', 'fail'), rec('A0', 2, 't1', 'pass'), rec('A0', 2, 'scr', 'pass'),
    rec('A4', 1, 'scr', 'pass'), rec('A4', 2, 'scr', 'pass'),
  ];

  it('keeps a family on clean sessions, and leaves it undecided when a session it counted is void', () => {
    expect(screenVerdicts(records({}), spec).kept).toEqual(['f1']);
    const v = screenVerdicts(records({ void: 'read' }), spec);
    expect(v.kept).toEqual([]);
    expect(v.undecided.map((r: { reason: string }) => r.reason)).toEqual(['t1 A0 seed1: void read']);
  });
});

describe('leak scan through a directory link', () => {
  it('searches the files under a linked rules dir instead of throwing EISDIR', (t) => {
    const root = tmp('z0-leak-root-');
    const target = tmp('z0-leak-target-');
    writeFileSync(join(target, 'r.md'), 'remember zq-linked before you start\n');
    mkdirSync(join(root, 'claude-config'));
    try {
      symlinkSync(target, join(root, 'claude-config', 'rules'), 'junction');
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'EPERM') t.skip();
      throw err;
    }
    const surfaces = { userInstructions: [{ path: 'claude-config/rules', sha256: 'x', size: 0, link: true }] };
    const at = { root, surfaces, stores: [] };
    expect(storedAt({ id: 'l1', keyPhrase: 'zq-linked' }, at)).toBe(true);
    expect(storedAt({ id: 'l2', keyPhrase: 'zq-absent' }, at)).toBe(false);
  });
});

describe('injected bullets', () => {
  it('counts a memory whose content holds a blank line, and leaves the next section out of it', () => {
    const imported = createMemory('first paragraph of the note\n\nsecond paragraph of the note', { source: 'agent-memory:claude-code:p/n.md#ab12', baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    const bullet = contextLine({ entry: imported, isGlobal: false }, 'observe', true, new Date());
    const text = ['## Project Memory (1 entries, 20 tokens)\n', bullet, '', '## Prompt-Relevant Memory (0 entries, 5 tokens)\n'].join('\n');
    const got = injectedRows([text], [{ ...imported, global: false }]);
    expect(got.counts).toMatchObject({ rows: 1, importedRows: 1, unmatched: 0, chars: bullet.length });
  });
});
